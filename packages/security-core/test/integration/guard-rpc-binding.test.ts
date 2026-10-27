import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { createRpcGuardBinding, type RpcGuardClient } from "../../src/monitoring/guard-rpc-binding";
import { deploySafeFixture, ZERO, fn, passkeySignature, safeContractSignatures, signSafeTransaction, transferAbi } from "../helpers/safe";

describe("Safe 1.5 observer RPC binding integration", () => {
  it("recomputes the canonical ExecutionSuccess hash and reads the guard transfer tuple", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const secondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, secondary.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const execute = async (to:Address,data:Hex,signature:Hex) => safe.write.execTransaction([to,0n,data,0,0n,0n,0n,ZERO,ZERO,signature],{account:deployer.account});
    const ownerCall = async (to:Address,data:Hex) => execute(to,data,await signSafeTransaction(safe,ecdsaSecondary,to,data));
    await ownerCall(guard.address,encodeFunctionData({abi:fn("configureSafeContractSecondary",[{name:"signer",type:"address"},{name:"enabled",type:"bool"}]),functionName:"configureSafeContractSecondary",args:[secondary.address,true]}));
    await ownerCall(guard.address,encodeFunctionData({abi:fn("setAssetPolicy",[{name:"token",type:"address"},{name:"basePerTransaction",type:"uint256"},{name:"stepUpPerTransaction",type:"uint256"},{name:"baseDailyLimit",type:"uint256"},{name:"instantDailyLimit",type:"uint256"},{name:"recipients",type:"address[]"}]),functionName:"setAssetPolicy",args:[token.address,10n,30n,10n,100n,[recipient.account.address]]}));
    await ownerCall(safe.address,encodeFunctionData({abi:fn("setGuard",[{name:"guard",type:"address"}]),functionName:"setGuard",args:[guard.address]}));
    const transfer=encodeFunctionData({abi:transferAbi,functionName:"transfer",args:[recipient.account.address,25n]});
    const expectedNonce=await safe.read.nonce();
    expect(expectedNonce > 0n).to.equal(true);
    const outerHash=await execute(token.address,transfer,safeContractSignatures(passkey.address,secondary.address));
    const receipt=await publicClient.waitForTransactionReceipt({hash:outerHash});
    const binding=createRpcGuardBinding(publicClient as unknown as RpcGuardClient,{chainId:31337,safe:safe.address,guard:guard.address,delay:delay.address,confirmations:1});
    const observed=await binding.readSafeTransaction(outerHash,receipt.blockNumber,receipt.blockHash);
    expect(observed).to.deep.equal({safe:getAddress(safe.address),to:getAddress(token.address),value:0n,data:transfer,operation:0,nonce:expectedNonce});
    const tuple=await guard.read.spendState([token.address],{blockNumber:receipt.blockNumber});
    expect(await binding.readSpendState(token.address,receipt.blockNumber)).to.deep.equal({window:tuple[0],baseSpent:tuple[1],instantSpent:tuple[2]});
    expect(tuple[1]).to.equal(0n);
    expect(tuple[2]).to.equal(25n);
  });
});
