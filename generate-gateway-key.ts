import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Generate a fresh keypair
const keypair = new Ed25519Keypair();
const address = keypair.getPublicKey().toSuiAddress();
const secretKey = keypair.getSecretKey();

console.log('=== SAVE THESE ===');
console.log('Gateway Address:', address);
console.log('Private Key:', secretKey);
console.log('==================');
console.log('');
console.log('Copy the Address and Private Key somewhere safe.');
