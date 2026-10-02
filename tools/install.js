// 通用安装器：node install2.js <pluginDir> [profileDir]
// 默认 profileDir = ~/.dsh/profiles/desktop（DeepSeek Harness 桌面端实际使用的 profile）
const fs = require('fs');
const path = require('path');
const H = String.fromCharCode(45);
const pluginDir = process.argv[2];
let profileDir = process.argv[3];
if (!profileDir) profileDir = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');

const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const name = pluginPkg.name;
const version = pluginPkg.version;
const pkgPath = path.join(profileDir, 'package.json');
const profile = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const link = path.join(profileDir, 'node_modules', name);
fs.mkdirSync(path.dirname(link), { recursive: true });
const before = fs.lstatSync(link, { throwIfNoEntry: false });
if (before && before.isSymbolicLink()) fs.unlinkSync(link);
const after = fs.lstatSync(link, { throwIfNoEntry: false });
if (!after) fs.symlinkSync(pluginDir, link, 'junction');
else console.log('warn.existingRealDir=true');

profile.dependencies = profile.dependencies || {};
profile.dependencies[name] = 'link:' + pluginDir.split(path.sep).join('/');
profile.dsh = profile.dsh || {};
profile.dsh.profile = profile.dsh.profile || {};
const bundles = profile.dsh.profile.bundles || [];
if (!bundles.includes(name)) bundles.push(name);
profile.dsh.profile.bundles = bundles;
fs.writeFileSync(pkgPath, JSON.stringify(profile, null, 2) + '\n');

const toolsDir = path.join(pluginDir, 'tools');
fs.mkdirSync(toolsDir, { recursive: true });
fs.copyFileSync(__filename, path.join(toolsDir, 'install.js'));

const check = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const lstat = fs.lstatSync(link);
const resolved = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'));
console.log('profileDir=' + profileDir);
console.log('link.isSymlink=' + lstat.isSymbolicLink());
console.log('resolved.name.equals=' + (resolved.name === name));
console.log('dep=' + check.dependencies[name]);
console.log('bundlesHas=' + check.dsh.profile.bundles.includes(name));
console.log('bundlesCount=' + check.dsh.profile.bundles.length);
console.log('bundlePatch.exists=' + fs.existsSync(path.join(link, 'cordis.patch.yml')));
console.log('clientEntry.exists=' + fs.existsSync(path.join(link, 'lib', 'client.js')));
console.log('archivedTool=' + fs.existsSync(path.join(toolsDir, 'install.js')));
