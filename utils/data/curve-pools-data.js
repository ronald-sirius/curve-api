import memoize from 'memoizee';
import { flattenArray } from 'utils/Array';
import getPools from 'pages/api/getPools';

const attachBlockchainId = (blockchainId, poolData) => ({
  ...poolData,
  blockchainId,
});

const attachFactoryTag = (poolData) => ({
  ...poolData,
  factory: true,
});

const getAllCurvePoolsData = memoize(async (blockchainIds) => (
  flattenArray(await Promise.all(flattenArray(blockchainIds.map((blockchainId) => [
    (getPools.straightCall({ blockchainId, registryId: 'main', preventQueryingFactoData: true }))
      .then((res) => res.poolData.map(attachBlockchainId.bind(null, blockchainId))),
    (getPools.straightCall({ blockchainId, registryId: 'crypto', preventQueryingFactoData: true }))
      .then((res) => res.poolData.map(attachBlockchainId.bind(null, blockchainId))),
    (getPools.straightCall({ blockchainId, registryId: 'factory', preventQueryingFactoData: true }))
      .then((res) => res.poolData.map(attachBlockchainId.bind(null, blockchainId)).map(attachFactoryTag)),
    (getPools.straightCall({ blockchainId, registryId: 'factory-crypto', preventQueryingFactoData: true }))
      .then((res) => res.poolData.map(attachBlockchainId.bind(null, blockchainId)).map(attachFactoryTag)),
  ]))))
), {
  promise: true,
  maxAge: 60 * 1000, // 60s
});

export default getAllCurvePoolsData;
