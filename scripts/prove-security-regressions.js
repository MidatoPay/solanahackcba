// Run the same regressions against 1734064 in an isolated, ignored copy.
// Leaves the working tree untouched and retains output for review.
import {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=process.cwd();await mkdir('.netlify',{recursive:true});
const target=await mkdtemp(resolve('.netlify/security-regression-'));
await writeFile(resolve(target,'package.json'),'{"type":"module"}');
for(const directory of ['src','netlify','db'])await cp(directory,resolve(target,directory),{recursive:true});
await mkdir(resolve(target,'test'));
for(const file of ['security-fixture.js','security-limits.test.js','security-focus.test.js','security-react.test.js','security-service.test.js'])
 await cp('test/'+file,resolve(target,'test',file));
for(const file of ['netlify/functions/security.js','netlify/functions/lib/securityRecovery.js','src/securitySession.js','src/securityLifecycle.js','src/SecurityGate.jsx']){
 const result=spawnSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show','1734064:'+file],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw new Error('Cannot read baseline: '+file);
 await writeFile(resolve(target,file),result.stdout);
}
await writeFile(resolve(target,'src/SecurityPanel.jsx'),"export {SecurityPanel} from './SecurityGate.jsx';\n");
for(const [name,pattern,file] of [
 ['limits','sessions sharing an IP','security-limits.test.js'],
 ['focus','native dialog result-first','security-focus.test.js'],
 ['safari','React prepares','security-react.test.js'],
 ['recovery','configured default recovery','security-service.test.js'],
]) {
 const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,'test/'+file],{cwd:target,encoding:'utf8',windowsHide:true,timeout:60000});
 const output=result.stdout+result.stderr;await writeFile(resolve(target,name+'.log'),output);
 if(result.status===0 || !output.includes('AssertionError'))throw new Error('Regression did not fail by assertion: '+name+'; inspect '+target);
 console.log(name+': baseline 1734064 fails the behavioral regression as expected');
}
console.log('Evidence: '+target);
