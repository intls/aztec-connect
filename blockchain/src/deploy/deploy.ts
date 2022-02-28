import { InitHelpers } from '@aztec/barretenberg/environment';
import { ContractFactory, Signer } from 'ethers';
import { EthAddress } from '@aztec/barretenberg/address';
import RollupProcessor from '../artifacts/contracts/RollupProcessor.sol/RollupProcessor.json';
import { addAsset, setSupportedAsset } from './add_asset/add_asset';
import { deployDefiBridge } from './deploy_defi_bridge';
import { deployDefiBridgeProxy } from './deploy_defi_bridge_proxy';
import { deployFeeDistributor } from './deploy_fee_distributor';
import { deployPriceFeed } from './deploy_price_feed';
import { createPair, deployUniswap, deployUniswapBridge } from './deploy_uniswap';
import { deployMockVerifier, deployVerifier } from './deploy_verifier';
import { deployElementBridge, elementAssets, elementConfig, setupElementPools } from './deploy_element';

// initialEthSupply = 0.1 ETH
export async function deploy(
  escapeHatchBlockLower: number,
  escapeHatchBlockUpper: number,
  signer: Signer,
  initialEthSupply = 1n * 10n ** 17n,
  vk?: string,
) {
  const signerAddress = await signer.getAddress();

  const uniswapRouter = await deployUniswap(signer);
  await uniswapRouter.deployed();

  const verifier = vk ? await deployVerifier(signer, vk) : await deployMockVerifier(signer);
  console.error('Deploying RollupProcessor...');
  const rollupFactory = new ContractFactory(RollupProcessor.abi, RollupProcessor.bytecode, signer);

  const defiProxy = await deployDefiBridgeProxy(signer);

  const chainId = await signer.getChainId();
  console.error(`Chain id: ${chainId}`);

  const { initDataRoot, initNullRoot, initRootsRoot } = InitHelpers.getInitRoots(chainId);
  const initDataSize: number = InitHelpers.getInitDataSize(chainId);
  console.error(`Initial data size: ${initDataSize}`);
  console.error(`Initial data root: ${initDataRoot.toString('hex')}`);
  console.error(`Initial null root: ${initNullRoot.toString('hex')}`);
  console.error(`Initial root root: ${initRootsRoot.toString('hex')}`);

  console.error(`Awaiting deployment...`);

  const rollup = await rollupFactory.deploy();

  await rollup.deployed();

  await rollup.initialize(
    verifier.address,
    escapeHatchBlockLower,
    escapeHatchBlockUpper,
    defiProxy.address,
    signerAddress,
    initDataRoot,
    initNullRoot,
    initRootsRoot,
    initDataSize,
  );

  console.error(`Rollup contract address: ${rollup.address}`);

  const feeDistributor = await deployFeeDistributor(signer, rollup, uniswapRouter);

  const permitSupport = false;
  const asset = await addAsset(rollup, signer, permitSupport);
  await addAsset(rollup, signer, permitSupport, 8);

  const gasPrice = 20n * 10n ** 9n; // 20 gwei
  const daiPrice = 1n * 10n ** 15n; // 1000 DAI/ETH
  const btcPrice = 2n * 10n ** 2n; // 0.05 ETH/BTC
  const initialTokenSupply = (initialEthSupply * 10n ** 18n) / daiPrice;
  await createPair(signer, uniswapRouter, asset, initialTokenSupply, initialEthSupply);

  const priceFeeds = [
    await deployPriceFeed(signer, gasPrice),
    await deployPriceFeed(signer, daiPrice),
    await deployPriceFeed(signer, btcPrice),
  ];

  // Defi bridge
  const defiBridges = [
    await deployDefiBridge(rollup, () => deployUniswapBridge(signer, rollup, uniswapRouter), 0n, [
      { inputAsset: EthAddress.ZERO.toString(), outputAssetA: asset.address },
    ]),
    await deployDefiBridge(rollup, () => deployUniswapBridge(signer, rollup, uniswapRouter), 0n, [
      { inputAsset: asset.address, outputAssetA: EthAddress.ZERO.toString() },
    ]),
  ];

  if (await signer.provider!.getCode(elementConfig.balancerAddress) != '0x') {
    console.error(`Balancer contract exists, deploying element bridge contract...`);
    const elementAssetConfigs = elementAssets.map(token => {
      return {
        inputAsset: token,
        outputAssetA: token,
      };
    });
    for (const elementAsset of elementAssetConfigs) {
      await setSupportedAsset(rollup, elementAsset.inputAsset, false);
    }
    defiBridges.push(
      await deployDefiBridge(
        rollup,
        () =>
          deployElementBridge(
            signer,
            rollup.address,
            elementConfig.trancheFactoryAddress,
            elementConfig.trancheByteCodeHash,
            elementConfig.balancerAddress,
          ),
        1000000n,
        elementAssetConfigs,
      ),
    );
    await setupElementPools(elementConfig, defiBridges[2]);
  } else {
    console.error(`Balancer contract not found, element bridge and it's assets won't be deployed.`);
  }

  const feePayingAssets = [EthAddress.ZERO.toString(), asset.address];

  return { rollup, feeDistributor, uniswapRouter, priceFeeds, defiBridges, feePayingAssets };
}
