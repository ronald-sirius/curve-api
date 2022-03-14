/* eslint-disable object-curly-newline */

import Web3 from 'web3';
import { fn } from 'utils/api';
import factoryV2RegistryAbi from 'constants/abis/factory-v2-registry.json';
import factoryPoolAbi from 'constants/abis/factory-v2/Plain2Balances.json';
import factoryCryptoRegistryAbi from 'constants/abis/factory-crypto-registry.json';
import cryptoRegistryAbi from 'constants/abis/crypto-registry.json';
import factoryCryptoPoolAbi from 'constants/abis/factory-crypto/factory-crypto-pool-2.json';
import erc20Abi from 'constants/abis/erc20.json';
import { multiCall } from 'utils/Calls';
import { flattenArray, sum, arrayToHashmap } from 'utils/Array';
import { getRegistry } from 'utils/getters';
import getTokensPrices from 'utils/data/tokens-prices';
import getAssetsPrices from 'utils/data/assets-prices';
import getFactoryV2GaugeRewards from 'utils/data/getFactoryV2GaugeRewards';
import getMainRegistryPools from 'pages/api/getMainRegistryPools';
import getGauges from 'pages/api/getGauges';
import configs from 'constants/configs';
import allCoins from 'constants/coins';

const POOL_BALANCE_ABI = [{ "gas": 1823, "inputs": [ { "name": "arg0", "type": "uint256" } ], "name": "balances", "outputs": [ { "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" }];

const POOL_PRICE_ORACLE_NO_ARGS_ABI = [{"stateMutability":"view","type":"function","name":"price_oracle","inputs":[],"outputs":[{"name":"","type":"uint256"}]}];
const POOL_PRICE_ORACLE_WITH_ARGS_ABI = [{"stateMutability":"view","type":"function","name":"price_oracle","inputs":[{"name":"k","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]}];

const getEthereumOnlyData = async () => {
  const [
    { poolList: mainRegistryPoolList },
    { gauges: gaugesData },
    gaugeRewards,
  ] = await Promise.all([
    getMainRegistryPools.straightCall(),
    getGauges.straightCall(),
    getFactoryV2GaugeRewards(),
  ]);

  const gaugesDataArray = Array.from(Object.values(gaugesData));
  const factoryGaugesPoolAddressesAndCoingeckoIdMap = arrayToHashmap(
    gaugesDataArray
      .filter(({ factory }) => factory === true)
      .map(({ swap, type: coingeckoId }) => [swap, coingeckoId])
  );

  const gaugesAssetPrices = await getAssetsPrices(Array.from(Object.values(factoryGaugesPoolAddressesAndCoingeckoIdMap)));
  const factoryGaugesPoolAddressesAndAssetPricesMap = arrayToHashmap(
    Array.from(Object.entries(factoryGaugesPoolAddressesAndCoingeckoIdMap))
      .map(([address, coingeckoId]) => [
        address.toLowerCase(),
        gaugesAssetPrices[coingeckoId],
      ])
  );

  return {
    mainRegistryPoolList: mainRegistryPoolList.map((address) => address.toLowerCase()),
    gaugesDataArray,
    gaugeRewards,
    factoryGaugesPoolAddressesAndAssetPricesMap,
  };
};

/**
 * Params:
 * - blockchainId: 'ethereum' (default) | any side chain
 * - registryId: 'factory' | 'main' | 'crypto' (note: we might we able to add 'factory-crypto' easily)
 */
export default fn(async ({ blockchainId, registryId }) => {
  /* eslint-disable no-param-reassign */
  if (typeof blockchainId === 'undefined') blockchainId = 'ethereum'; // Default value
  if (typeof registryId === 'undefined') registryId = 'main'; // Default value
  /* eslint-enable no-param-reassign */

  console.log({ blockchainId, registryId });

  const config = configs[blockchainId];
  if (typeof config === 'undefined') {
    throw new Error(`No factory data for blockchainId "${blockchainId}"`);
  }

  const {
    nativeCurrencySymbol,
    platformCoingeckoId,
    rpcUrl,
    factoryImplementationAddressMap: implementationAddressMap,
    getFactoryRegistryAddress,
    getCryptoRegistryAddress,
    getFactoryCryptoRegistryAddress,
    multicallAddress,
    BASE_POOL_LP_TO_GAUGE_LP_MAP,
    DISABLED_POOLS_ADDRESSES,
  } = config;

  if (registryId !== 'factory' && registryId !== 'main' && registryId !== 'crypto' && registryId !== 'factory-crypto') {
    throw new Error('registryId must be \'factory\'|\'main\'|\'crypto\'|\'factory-crypto\'');
  }

  if (registryId === 'factory' && typeof getFactoryRegistryAddress !== 'function') {
    throw new Error(`No getFactoryRegistryAddress() config method found for blockchainId "${blockchainId}"`);
  }

  if (registryId === 'crypto' && typeof getCryptoRegistryAddress !== 'function') {
    throw new Error(`No getCryptoRegistryAddress() config method found for blockchainId "${blockchainId}"`);
  }

  if (registryId === 'factory-crypto' && typeof getFactoryCryptoRegistryAddress !== 'function') {
    throw new Error(`No getFactoryCryptoRegistryAddress() config method found for blockchainId "${blockchainId}"`);
  }

  const assetTypeMap = new Map([
    ['0', 'usd'],
    ['1', nativeCurrencySymbol.toLowerCase()],
    ['2', 'btc'],
    ['3', 'other'],
  ]);

  const registryAddress = (
    registryId === 'factory' ? await getFactoryRegistryAddress() :
    registryId === 'main' ? await getRegistry({ blockchainId }) :
    registryId === 'crypto' ? await getCryptoRegistryAddress() :
    registryId === 'factory-crypto' ? await getFactoryCryptoRegistryAddress() :
    undefined
  );

  const getIdForPool = (id) => (
    registryId === 'factory' ? `factory-v2-${id}` :
    registryId === 'main' ? `${id}` :
    registryId === 'crypto' ? `crypto-${id}` :
    registryId === 'factory-crypto' ? `factory-crypto-${id}` :
    undefined
  );

  const POOL_ABI = (
    registryId === 'factory-crypto' ? factoryCryptoPoolAbi :
    factoryPoolAbi
  );

  const REGISTRY_ABI = (
    registryId === 'factory-crypto' ? factoryCryptoRegistryAbi :
    registryId === 'crypto' ? cryptoRegistryAbi :
    factoryV2RegistryAbi
  );

  const web3 = new Web3(rpcUrl);
  const registry = new web3.eth.Contract(REGISTRY_ABI, registryAddress);

  const networkSettingsParam = (
    typeof multicallAddress !== 'undefined' ?
      { networkSettings: { web3, multicallAddress } } :
      undefined
  );

  const poolCount = Number(await registry.methods.pool_count().call());
  if (poolCount === 0) return { poolData: [], tvlAll: 0, tvl: 0 };

  const unfileteredPoolIds = Array(poolCount).fill(0).map((_, i) => i);

  const unfilteredPoolAddresses = await multiCall(unfileteredPoolIds.map((id) => ({
    contract: registry,
    methodName: 'pool_list',
    params: [id],
    ...networkSettingsParam,
  })));

  // Filter out broken pools, see reason for each in DISABLED_POOLS_ADDRESSES definition
  const poolAddresses = unfilteredPoolAddresses.filter((address) => (
    !DISABLED_POOLS_ADDRESSES.includes(address.toLowerCase())
  ));
  const poolIds = unfileteredPoolIds.filter((id) => (
    !DISABLED_POOLS_ADDRESSES.includes(unfilteredPoolAddresses[id].toLowerCase())
  ));

  const ethereumOnlyData = blockchainId === 'ethereum' ?
    await getEthereumOnlyData() :
    undefined;

  const poolData = await multiCall(flattenArray(poolAddresses.map((address, i) => {
    const poolId = poolIds[i];
    const poolContract = new web3.eth.Contract(POOL_ABI, address);

    // Note: reverting for at least some pools, prob non-meta ones: get_underlying_coins, get_underlying_decimals
    return [{
      contract: registry,
      methodName: 'get_coins', // address[4]
      params: [address],
      metaData: { poolId, type: 'coinsAddresses' },
      ...networkSettingsParam,
    }, {
      contract: registry,
      methodName: 'get_decimals', // address[4]
      params: [address],
      metaData: { poolId, type: 'decimals' },
      ...networkSettingsParam,
    },
    // 'main' and 'factory' registries have these pieces of info, others do not
    ...(
      (registryId === 'main' || registryId === 'factory') ? [{
        contract: registry,
        methodName: 'get_underlying_decimals', // address[8]
        params: [address],
        metaData: { poolId, type: 'underlyingDecimals' },
        ...networkSettingsParam,
      }, {
        contract: registry,
        methodName: 'get_pool_asset_type', // uint256
        params: [address],
        metaData: { poolId, type: 'assetType' },
        ...networkSettingsParam,
      }] : []
    ),
    ...(
      registryId === 'factory' ? [{
        contract: registry,
        methodName: 'get_implementation_address', // address
        params: [address],
        metaData: { poolId, type: 'implementationAddress' },
        ...networkSettingsParam,
      }, {
        contract: poolContract,
        methodName: 'totalSupply',
        metaData: { poolId, type: 'totalSupply' },
        ...networkSettingsParam,
      }, {
        contract: poolContract,
        methodName: 'name',
        metaData: { poolId, type: 'name' },
        ...networkSettingsParam,
      }, {
        contract: poolContract,
        methodName: 'symbol',
        metaData: { poolId, type: 'symbol' },
        ...networkSettingsParam,
      }] : [] // Not fetching totalSupply for main pools because not all pool implementations have a lp token
    ),
    ...(
      registryId === 'factory-crypto' ? [{
        contract: registry,
        methodName: 'get_token', // address
        params: [address],
        metaData: { poolId, type: 'lpTokenAddress' },
        ...networkSettingsParam,
      }] : []
    ),
    ...(
      registryId === 'crypto' ? [{
        contract: registry,
        methodName: 'get_lp_token', // address
        params: [address],
        metaData: { poolId, type: 'lpTokenAddress' },
        ...networkSettingsParam,
      }] : []
    )];
  })));

  const tweakedPoolData = (
    (registryId === 'factory' && typeof BASE_POOL_LP_TO_GAUGE_LP_MAP !== 'undefined') ?
      // coinsAddresses doesn’t contain the lp token on factory registry, add it
      poolData.map(({ data, metaData }) => {
        if (metaData.type === 'coinsAddresses') {
          const { data: poolImplementationAddress } = poolData.find((d) => (
            d.metaData.poolId === metaData.poolId &&
            d.metaData.type === 'implementationAddress'
          ));

          const implementation = implementationAddressMap.get(poolImplementationAddress.toLowerCase());

          const isMetaPool = (
            implementation === 'metausd' ||
            implementation === 'metausdbalances' ||
            implementation === 'metabtc' ||
            implementation === 'metabtcbalances'
          );

          const isUsdMetaPool = isMetaPool && implementation.startsWith('metausd');
          const isBtcMetaPool = isMetaPool && implementation.startsWith('metabtc');

          const coinsAddresses = [...data];

          const [
            metaUsdLpTokenAddress,
            metaBtcLpTokenAddress,
          ] = Array.from(BASE_POOL_LP_TO_GAUGE_LP_MAP.keys());
          if (isUsdMetaPool) coinsAddresses[1] = metaUsdLpTokenAddress;
          if (isBtcMetaPool) coinsAddresses[1] = metaBtcLpTokenAddress;

          return {
            data: coinsAddresses,
            metaData,
          };
        }

        return { data, metaData };
      }) :
      poolData
  );

  const lpTokensWithMetadata = tweakedPoolData.filter(({ metaData }) => metaData.type === 'lpTokenAddress');
  const lpTokenData = (
    lpTokensWithMetadata.length === 0 ? [] :
    await multiCall(flattenArray(lpTokensWithMetadata.map(({
      data: address,
      metaData,
    }) => {
      const lpTokenContract = new web3.eth.Contract(erc20Abi, address);
      const poolCoinsCount = tweakedPoolData.find(({ metaData: { type, poolId } }) => (
        type === 'coinsAddresses' &&
        poolId === metaData.poolId
      )).data.filter((coinAddress) => coinAddress !== '0x0000000000000000000000000000000000000000').length;
      const poolHasMultipleOracles = poolCoinsCount > 2;
      const poolAddress = poolAddresses[poolIds.indexOf(metaData.poolId)];
      const poolContractForPriceOracleCall = new web3.eth.Contract(poolHasMultipleOracles ? POOL_PRICE_ORACLE_WITH_ARGS_ABI : POOL_PRICE_ORACLE_NO_ARGS_ABI, poolAddress);

      return [{
        contract: lpTokenContract,
        methodName: 'name',
        metaData: { poolId: metaData.poolId, type: 'name' },
        ...networkSettingsParam,
      }, {
        contract: lpTokenContract,
        methodName: 'symbol',
        metaData: { poolId: metaData.poolId, type: 'symbol' },
        ...networkSettingsParam,
      }, {
        contract: lpTokenContract,
        methodName: 'totalSupply',
        metaData: { poolId: metaData.poolId, type: 'totalSupply' },
        ...networkSettingsParam,
      }, {
        contract: poolContractForPriceOracleCall,
        methodName: 'price_oracle', // uint256
        params: poolHasMultipleOracles ? [0] : [], // Price oracle for first asset, there are N-1 oracles so we can fetch more if needed
        metaData: { poolId: metaData.poolId, type: 'priceOracle' },
        ...networkSettingsParam,
      }];
    })))
  );

  const augmentedPoolData = [
    ...tweakedPoolData,
    ...lpTokenData,
  ];

  const allCoinAddresses = augmentedPoolData.reduce((accu, { data, metaData: { poolId, type } }) => {
    if (type === 'coinsAddresses') {
      const poolCoins = data.filter((address) => address !== '0x0000000000000000000000000000000000000000');
      return accu.concat(poolCoins.map((address) => ({ poolId, address })));
    }

    return accu;
  }, []);

  const coinAddressesAndPricesMap =
    await getTokensPrices(allCoinAddresses.map(({ address }) => address), platformCoingeckoId);

  const coinData = await multiCall(flattenArray(allCoinAddresses.map(({ poolId, address }) => {
    // In crypto facto pools, native eth is represented as weth
    const isNativeEth = (
      registryId === 'factory-crypto' ?
        address.toLowerCase() === allCoins[config.nativeAssetErc20WrapperId].address.toLowerCase() :
        address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    );
    const coinContract = isNativeEth ? undefined : new web3.eth.Contract(erc20Abi, address);

    const poolAddress = poolAddresses[poolIds.indexOf(poolId)];
    const poolContract = new web3.eth.Contract(POOL_BALANCE_ABI, poolAddress);
    const coinIndex = poolData.find(({ metaData }) => (
      metaData.type === 'coinsAddresses' &&
      metaData.poolId === poolId
    )).data.indexOf(address);

    return [...(isNativeEth ? [{
      contract: poolContract,
      methodName: 'balances',
      params: [coinIndex],
      metaData: { poolId, poolAddress, coinAddress: address, isNativeEth, type: 'poolBalance' },
      ...networkSettingsParam,
    }] : [{
      contract: coinContract,
      methodName: 'decimals',
      metaData: { poolId, poolAddress, coinAddress: address, isNativeEth, type: 'decimals' },
      ...networkSettingsParam,
    }, {
      contract: coinContract,
      methodName: 'symbol',
      metaData: { poolId, poolAddress, coinAddress: address, isNativeEth, type: 'symbol' },
      ...networkSettingsParam,
    }, {
      contract: coinContract,
      methodName: 'balanceOf',
      params: [poolAddress],
      metaData: { poolId, poolAddress, coinAddress: address, isNativeEth, type: 'poolBalance' },
      ...networkSettingsParam,
    }]), ...(
      (typeof BASE_POOL_LP_TO_GAUGE_LP_MAP !== 'undefined' && BASE_POOL_LP_TO_GAUGE_LP_MAP.has(address)) ?
        [{
          contract: new web3.eth.Contract(erc20Abi, BASE_POOL_LP_TO_GAUGE_LP_MAP.get(address)),
          methodName: 'balanceOf',
          params: [poolAddress],
          metaData: { poolId, poolAddress, coinAddress: address, isNativeEth, type: 'poolStakedBalance' },
          ...networkSettingsParam,
        }] :
        []
    )];
  })));

  // TODO refactor this
  if (blockchainId === 'fantom' || blockchainId === 'avalanche') {
    (coinData.find(x => x.data === 'USDL Stablecoin')) ? coinData.find(x => x.data === 'USDL Stablecoin').data = 'USDL' : ''
    (coinData.find(x => x.data === 'Fantom-L')) ? coinData.find(x => x.data === 'Fantom-L').data = 'FTM-L' : ''
  }

  const mergedCoinData = coinData.reduce((accu, { data, metaData: { poolId, poolAddress, coinAddress, type, isNativeEth } }) => {
    const key = `${getIdForPool(poolId)}-${coinAddress}`;
    const coinInfo = accu[key];
    const coinPrice = (
      coinAddressesAndPricesMap[coinAddress.toLowerCase()] ||
      (registryId === 'factory' && ethereumOnlyData?.factoryGaugesPoolAddressesAndAssetPricesMap?.[poolAddress.toLowerCase()]) ||
      0
    );

    const hardcodedInfoForNativeEth = {
      decimals: 18,
      symbol: nativeCurrencySymbol,
    };

    // eslint-disable-next-line no-param-reassign
    accu[key] = {
      ...coinInfo,
      address: coinAddress,
      usdPrice: coinPrice,
      ...(type === 'poolStakedBalance' ?
        { poolBalance: Number(coinInfo.poolBalance) + Number(data) } :
        { [type]: data }
      ),
      ...(isNativeEth ? hardcodedInfoForNativeEth : {}),
    };

    return accu;
  }, {});

  const emptyData = poolIds.map((id) => ({ id: getIdForPool(id) }));
  const mergedPoolData = augmentedPoolData.reduce((accu, { data, metaData: { poolId, type } }) => {
    const index = accu.findIndex(({ id }) => id === getIdForPool(poolId));
    const poolInfo = accu[index];

    // eslint-disable-next-line no-param-reassign
    accu[index] = {
      ...poolInfo,
      address: poolAddresses[index],
      [type]: (
        type === 'priceOracle' ?
          (data / 1e18) :
          data
      ),
    };

    return accu;
  }, emptyData);

  const augmentedData = mergedPoolData.map((poolInfo) => {
    const implementation = (
      registryId === 'factory' ?
        implementationAddressMap.get(poolInfo.implementationAddress.toLowerCase()) :
        ''
    );

    const isUsdMetaPool = implementation.startsWith('metausd') || implementation.startsWith('v1metausd');
    const isBtcMetaPool = implementation.startsWith('metabtc') || implementation.startsWith('v1metabtc');

    // We derive asset type (i.e. used as the reference asset on the FE) from pool implementation if possible,
    // and fall back to the assetType prop.
    const assetTypeName = (
      (implementation === 'plain2eth' || implementation === 'plain3eth' || implementation === 'plain4eth') ? nativeCurrencySymbol.toLowerCase() :
      isBtcMetaPool ? 'btc' :
      isUsdMetaPool ? 'usd' :
      (assetTypeMap.get(poolInfo.assetType) || 'unknown')
    );

    const coins = poolInfo.coinsAddresses
      .filter((address) => address !== '0x0000000000000000000000000000000000000000')
      .map((coinAddress) => {
        const key = `${poolInfo.id}-${coinAddress}`;

        return {
          ...mergedCoinData[key],
          usdPrice: mergedCoinData[key]?.usdPrice || null,
        };
      });

    // The current logic is simplistic, and only allows filling in the blanks when
    // a pool is missing a single coin's price at index 0 or 1. Let's improve it later
    // if other situations arise where more is necessary.
    const canFixCoinPricesThatNeedIt = (
      coins.filter(({ usdPrice }) => usdPrice === null).length === 1 &&
      (coins.length === 2 || coins.findIndex(({ usdPrice }) => usdPrice === null) < 2) &&
      !!poolInfo.priceOracle
    );

    const augmentedCoins = (
      canFixCoinPricesThatNeedIt ? (
        coins.map((coin, i) => (
          coin.usdPrice === null ? {
            ...coin,
            usdPrice: (
              i === 0 ?
                (coins[1].usdPrice / poolInfo.priceOracle) :
                (coins[0].usdPrice * poolInfo.priceOracle)
            ),
          } : coin
        ))
      ) : coins
    );

    const usdTotal = sum(augmentedCoins.map(({ usdPrice, poolBalance, decimals }) => (
      poolBalance / (10 ** decimals) * usdPrice
    )));

    const gaugeAddress = typeof ethereumOnlyData !== 'undefined' ?
      ethereumOnlyData.gaugesDataArray.find(({ swap }) => swap.toLowerCase() === poolInfo.address.toLowerCase())?.gauge?.toLowerCase() :
      undefined;
    const gaugeRewardsInfo = gaugeAddress ? ethereumOnlyData.gaugeRewards[gaugeAddress] : undefined;

    return {
      ...poolInfo,
      implementation,
      assetTypeName,
      coins: augmentedCoins,
      usdTotal,
      gaugeAddress,
      gaugeRewards: gaugeRewardsInfo,
    };
  });

  // The distinction between tvlAll and tvl is useful when facto pools are added to the main
  // registry, in order to avoid double-counting tvl.
  return {
    poolData: augmentedData,
    tvlAll: sum(augmentedData.map(({ usdTotal }) => usdTotal)),
    ...(typeof ethereumOnlyData !== 'undefined' ? {
      tvl: sum(
        registryId === 'factory' ? (
          augmentedData
            .filter(({ address }) => !ethereumOnlyData.mainRegistryPoolList.includes(address.toLowerCase()))
            .map(({ usdTotal }) => usdTotal)
        ) : (
          augmentedData.map(({ usdTotal }) => usdTotal)
        )
      ),
    } : {}),
  };
}, {
  maxAge: 60,
});
