const { createRequire } = require('node:module');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const assert = require('node:assert/strict');
const fromCore = createRequire(join(process.cwd(), 'package.json'));
const hre = fromCore('hardhat');
const v = fromCore('viem');
const { createAutomatedCredential, signWebAuthn } = fromCore('./scripts/live/webauthn.ts');
const safeArtifact = fromCore('@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json');
const proxyArtifact = fromCore('@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json');
const factoryArtifact = fromCore('@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json');
const verifierArtifact = fromCore('@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json');
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ZERO = v.zeroAddress;
const MODULE_TARBALL = 'https://registry.npmjs.org/@safe-global/safe-4337/-/safe-4337-0.3.0-1.tgz';
const MODULE_TARBALL_SHA256 = '7be4a60729e8df59fe6f7b691057c8609188cfbab2af2b76612e8d97ae095642';
const facts = [];
const fact = (name, detail) => { facts.push({ name, ...detail }); console.log(JSON.stringify(facts.at(-1), (_, x) => typeof x === 'bigint' ? x.toString() : x)); };
const slot = (address, payload) => v.concatHex([v.padHex(address, {size:32}), v.toHex(65n,{size:32}), '0x00', v.toHex(v.size(payload),{size:32}), payload]);

async function publishedArtifacts() {
  const response = await fetch(MODULE_TARBALL);
  assert.equal(response.status, 200, 'published module tarball is unavailable');
  const compressed = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(compressed).digest('hex'), MODULE_TARBALL_SHA256, 'published module tarball changed');
  const tar = gunzipSync(compressed);
  const wanted = new Map([
    ['package/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json', 'module'],
    ['package/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json', 'setup'],
  ]);
  const found = {};
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'invalid tar entry size');
    const dataStart = offset + 512;
    assert.ok(dataStart + size <= tar.length, 'truncated tar entry');
    if (wanted.has(name)) found[wanted.get(name)] = JSON.parse(tar.subarray(dataStart, dataStart + size).toString());
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert.ok(found.module && found.setup, 'published artifacts missing');
  return found;
}

async function main() {
  const {module:moduleArtifact,setup:setupArtifact}=await publishedArtifacts();
  const [payer, secondaryEoa, recipient] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deploy = async (a, args=[]) => {
    const hash = await payer.deployContract({abi:a.abi, bytecode:a.bytecode, args});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    assert.equal(receipt.status, 'success');
    return v.getContract({address:receipt.contractAddress,abi:a.abi,client:{public:publicClient,wallet:payer}});
  };
  const verifier = await deploy(verifierArtifact);
  const factory = await deploy(factoryArtifact);
  const passkey = async () => {
    const credential = createAutomatedCredential();
    const args=[credential.x,credential.y,BigInt(verifier.address)];
    await factory.write.createSigner(args);
    return { credential, address:await factory.read.getSigner(args) };
  };
  const primary=await passkey(), secondary=await passkey();
  const module=await deploy(moduleArtifact,[EP]);
  const moduleSetup=await deploy(setupArtifact);
  const singleton=await deploy(safeArtifact);
  const proxy=await deploy(proxyArtifact,[singleton.address]);
  const safe=v.getContract({address:proxy.address,abi:safeArtifact.abi,client:{public:publicClient,wallet:payer}});
  const setupData=v.encodeFunctionData({abi:setupArtifact.abi,functionName:'enableModules',args:[[module.address]]});
  await safe.write.setup([[primary.address],1n,moduleSetup.address,setupData,module.address,ZERO,0n,ZERO]);
  await payer.sendTransaction({to:safe.address,value:1000n});
  const digest=async(to,value,data)=>safe.read.getTransactionHash([to,value,data,0,0n,0n,0n,ZERO,ZERO,await safe.read.nonce()]);
  const innerSignature=async(to,value,data)=>slot(primary.address,signWebAuthn(primary.credential,await digest(to,value,data)));
  const ownerCall=async(to,value,data)=>safe.write.execTransaction([to,value,data,0,0n,0n,0n,ZERO,ZERO,await innerSignature(to,value,data)]);
  const legacy=v.parseAbi(['function checkSignatures(bytes32,bytes,bytes) view']);
  const randomDigest=v.keccak256('0x1234');
  await publicClient.readContract({address:safe.address,abi:legacy,functionName:'checkSignatures',args:[randomDigest,'0x',slot(primary.address,signWebAuthn(primary.credential,randomDigest))]});
  fact('safe15_legacy_signature_overload', {validRealPasskey:true, safeRuntimeHash:v.keccak256(await publicClient.getCode({address:singleton.address})), moduleRuntimeHash:v.keccak256(await publicClient.getCode({address:module.address})), safeVersion:await safe.read.VERSION()});
  const executeData=v.encodeFunctionData({abi:moduleArtifact.abi,functionName:'executeUserOp',args:[recipient.account.address,1n,'0x',0]});
  const op={sender:safe.address,nonce:0n,initCode:'0x',callData:executeData,accountGasLimits:v.toHex(0n,{size:32}),preVerificationGas:0n,gasFees:v.toHex(0n,{size:32}),paymasterAndData:'0x',signature:v.toHex(0n,{size:12})};
  const opHash=await module.read.getOperationHash([op]);
  op.signature=v.concatHex([v.toHex(0n,{size:12}),slot(primary.address,signWebAuthn(primary.credential,opHash))]);
  const validate=async(userOp,missingFunds=0n)=>(await publicClient.simulateContract({address:safe.address,abi:moduleArtifact.abi,functionName:'validateUserOp',args:[userOp,v.keccak256('0x01'),missingFunds],account:EP})).result;
  assert.equal(await validate(op),0n);
  const changed={...op,callData:v.encodeFunctionData({abi:moduleArtifact.abi,functionName:'executeUserOp',args:[recipient.account.address,2n,'0x',0]})};
  assert.equal(await validate(changed),1n);
  fact('standard_module_validation', {validRealPasskey:0,mutatedCallData:1,missingAccountFunds:0,entryPointImpersonated:true,actualEntryPointOrBundler:false});
  await hre.network.provider.send('hardhat_impersonateAccount',[EP]);
  await hre.network.provider.send('hardhat_setBalance',[EP,'0x1000000000000000000']);
  const epWallet=await hre.viem.getWalletClient(EP);
  const execute=async(to,value,data)=>epWallet.writeContract({address:safe.address,abi:moduleArtifact.abi,functionName:'executeUserOp',args:[to,value,data,0]});
  const initialNonce=await safe.read.nonce();
  const initialBalance=await publicClient.getBalance({address:safe.address});
  await execute(recipient.account.address,1n,'0x');
  assert.equal(await publicClient.getBalance({address:safe.address}),initialBalance-1n);
  assert.equal(await safe.read.nonce(),initialNonce);
  fact('unguarded_module_execution', {success:true,safeNonceUnchanged:true});

  const delay=await hre.viem.deployContract('ZodiacDelayV1_1_1',[safe.address,safe.address,safe.address,120n,600n]);
  const guard=await hre.viem.deployContract('TieredSpendingGuard',[[safe.address,primary.address,secondaryEoa.account.address,delay.address,86400n,0n]]);
  await ownerCall(guard.address,0n,v.encodeFunctionData({abi:guard.abi,functionName:'configureSafeContractSecondary',args:[secondary.address,true]}));
  await ownerCall(guard.address,0n,v.encodeFunctionData({abi:guard.abi,functionName:'setAssetPolicy',args:[ZERO,10n,30n,10n,30n,[recipient.account.address]]}));
  await ownerCall(safe.address,0n,v.encodeFunctionData({abi:safeArtifact.abi,functionName:'enableModule',args:[delay.address]}));
  await ownerCall(delay.address,0n,v.encodeFunctionData({abi:delay.abi,functionName:'enableModule',args:[safe.address]}));
  await ownerCall(safe.address,0n,v.encodeFunctionData({abi:safeArtifact.abi,functionName:'setModuleGuard',args:[guard.address]}));
  await ownerCall(safe.address,0n,v.encodeFunctionData({abi:safeArtifact.abi,functionName:'setGuard',args:[guard.address]}));
  const reject=async(name,action)=>{let rejected=false;try{await action();}catch{rejected=true;}assert.equal(rejected,true,name);fact(name,{rejected:true});};
  await reject('unchanged_guard_rejects_direct_module_transfer',()=>execute(recipient.account.address,1n,'0x'));
  const wrapped=v.encodeFunctionData({abi:safeArtifact.abi,functionName:'execTransaction',args:[recipient.account.address,1n,'0x',0,0n,0n,0n,ZERO,ZERO,await innerSignature(recipient.account.address,1n,'0x')]});
  await reject('unchanged_guard_rejects_wrapped_owner_transaction',()=>execute(safe.address,0n,wrapped));
  const arbitrary=v.keccak256('0xabcdef');
  const safeMessageDigest=v.hashTypedData({domain:{chainId:31337,verifyingContract:safe.address},types:{SafeMessage:[{name:'message',type:'bytes'}]},primaryType:'SafeMessage',message:{message:v.encodeAbiParameters([{type:'bytes32'}],[arbitrary])}});
  const messageSignature=slot(primary.address,signWebAuthn(primary.credential,safeMessageDigest));
  const messageAbi=v.parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
  const stateBefore=await guard.read.spendState([ZERO]);
  const nonceBefore=await safe.read.nonce();
  const magic=await publicClient.readContract({address:safe.address,abi:messageAbi,functionName:'isValidSignature',args:[arbitrary,messageSignature]});
  assert.equal(magic,'0x1626ba7e');
  assert.deepEqual(await guard.read.spendState([ZERO]),stateBefore);
  assert.equal(await safe.read.nonce(),nonceBefore);
  await reject('mutated_message_signature_rejected',()=>publicClient.readContract({address:safe.address,abi:messageAbi,functionName:'isValidSignature',args:[v.keccak256('0xabcdee'),messageSignature]}));
  fact('arbitrary_safe_message_bypasses_transaction_hooks',{magic,guardCountersUnchanged:true,safeNonceUnchanged:true,realPasskey:true});
  await ownerCall(recipient.account.address,6n,'0x');
  await ownerCall(recipient.account.address,4n,'0x');
  await reject('ordinary_guard_still_enforces_X',()=>ownerCall(recipient.account.address,1n,'0x'));
  assert.deepEqual((await guard.read.spendState([ZERO])).slice(1),[10n,10n]);
  fact('ordinary_guard_X_control',{baseSpent:10,instantSpent:10});
  await hre.network.provider.send('hardhat_stopImpersonatingAccount',[EP]);
  const result={schemaVersion:1,scope:'local compatibility research, no modified contracts',chainId:31337,safe:'1.5.0',safe4337:'0.3.0-1',passkey:'0.2.0',limits:['EntryPoint caller impersonation only','No real EntryPoint execution or nonce validation','No bundler, sponsor, browser, live RPC or installation proof','No guard adaptation implemented or tested'],facts};
  writeFileSync('docs/evidence/2026-11-19-standard-safe4337-probe.json',JSON.stringify(result,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n');
}
main().catch(error=>{console.error(error.shortMessage||error.message);process.exitCode=1;});
