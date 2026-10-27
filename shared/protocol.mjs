import constants from './poseidon-constants.json' with { type: 'json' };
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ROLES = ['Doctor','Coordinator','Procurement','Matching','Transporter','Surgeon'];
export const MASKS = [7,7,3,1,0,9];
const C = constants.C.map(BigInt), M = constants.M.map(row => row.map(BigInt));
const mod = x => ((x % FIELD) + FIELD) % FIELD;
const pow5 = x => { const x2 = x*x % FIELD; return x2*x2 % FIELD*x % FIELD; };
// Circomlib Poseidon(2) reference parameters. Cross-checked against circomlibjs.
export function hash(a,b) {
 let state = [0n,mod(BigInt(a)),mod(BigInt(b))];
 for (let r=0;r<65;r++) {
  state=state.map((x,i)=>mod(x+C[r*3+i]));
  state=state.map((x,i)=>(r<4||r>=61||i===0)?pow5(x):x);
  state=M.map(row=>mod(row.reduce((sum,x,i)=>sum+x*state[i],0n)));
 }
 return state[0];
}
export function tree(leaves, index=0, depth=20) {
 if (leaves.length > 2**depth || index<0 || index>=Math.max(1,leaves.length)) throw Error('Invalid membership index');
 let layer=leaves.map(BigInt), zero=0n, position=index;
 const pathElements=[],pathIndices=[];
 for(let level=0;level<depth;level++) {
  pathElements.push((layer[position^1]??zero).toString()); pathIndices.push(position%2);
  const next=[];
  for(let i=0;i<Math.max(1,layer.length);i+=2) next.push(hash(layer[i]??zero,layer[i+1]??zero));
  layer=next; zero=hash(zero,zero); position=Math.floor(position/2);
 }
 return {root:layer[0].toString(),pathElements,pathIndices};
}
export function proofInput({credential,salt,roleId,recipient,chainId,issuer,rootVersion,leaves}) {
 const leaf=hash(credential,roleId).toString(), index=leaves.indexOf(leaf);
 if(index<0) throw Error('Credential is not enrolled');
 const path=tree(leaves,index);
 const domain=hash(salt,hash(recipient,hash(chainId,hash(issuer,rootVersion))));
 return {credential:String(credential),salt:String(salt),roleId:String(roleId),recipient:String(BigInt(recipient)),
  chainId:String(chainId),issuer:String(BigInt(issuer)),rootVersion:String(rootVersion),
  merkleRoot:path.root,nullifier:hash(credential,domain).toString(),pathElements:path.pathElements,pathIndices:path.pathIndices};
}
export function validateAttributes(a) {
 if(!a || !['O','A','B','AB'].includes(a.abo) || !Array.isArray(a.features) || a.features.length!==6 ||
  a.features.some(x=>x!==0&&x!==1) || !Number.isInteger(a.urgency) || a.urgency<0 || a.urgency>2)
  throw Error('Expected ABO O/A/B/AB, six binary synthetic features, urgency 0/1/2');
 return {abo:a.abo,features:[...a.features],urgency:a.urgency};
}
// Experimental policy, not a clinical allocation model.
export function referenceScore(d,r) {
 validateAttributes(d);validateAttributes(r);
 const allowed={O:['O','A','B','AB'],A:['A','AB'],B:['B','AB'],AB:['AB']};
 if(!allowed[d.abo].includes(r.abo)) return {eligible:false,score:null};
 const m=d.features.reduce((sum,x,i)=>sum+(x-r.features[i])**2,0);
 return {eligible:true,score:Math.round((4200-700*m+900*r.urgency)/6)};
}
