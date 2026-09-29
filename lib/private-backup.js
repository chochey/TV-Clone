// Root backup jobs must never follow shortcuts from application-writable state.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function privateDirectory(dir) {
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(!fs.lstatSync(dir).isDirectory())throw Error('Backup directory is not a regular directory');
 fs.chmodSync(dir,0o700);
 if(process.getuid?.()===0)fs.chownSync(dir,0,0);
}
function copyPrivate(source,destination,{maxBytes=256*1024*1024}={}) {
 const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const tmp=destination+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 let output;
 try {
  const st=fs.fstatSync(input);
  if(!st.isFile() || st.size>maxBytes)throw Error('Backup source is not a regular bounded file');
  privateDirectory(path.dirname(destination));
  output=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  const buffer=Buffer.alloc(65536);let bytes=0,n;
  while((n=fs.readSync(input,buffer,0,buffer.length,null))>0){bytes+=n;if(bytes>maxBytes)throw Error('Backup source grew beyond its limit');let offset=0;while(offset<n)offset+=fs.writeSync(output,buffer,offset,n-offset);}
  fs.fsyncSync(output);fs.closeSync(output);output=undefined;
  fs.renameSync(tmp,destination);
  const directory=fs.openSync(path.dirname(destination),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
 } finally {fs.closeSync(input);if(output!==undefined)fs.closeSync(output);try{fs.unlinkSync(tmp);}catch{}}
}
function approvedConfigSource(repoDir) {
 const file=path.join(repoDir,'config.json');
 if(fs.lstatSync(file).isSymbolicLink()) {
  if(fs.readlinkSync(file)!=='data/config.json')throw Error('Unapproved config shortcut');
  return path.join(repoDir,'data','config.json');
 }
 return file;
}
module.exports={privateDirectory,copyPrivate,approvedConfigSource};
