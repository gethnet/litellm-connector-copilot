import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import process from 'node:process';

const rootDir = process.cwd();
const packageJsonPath = join(rootDir, 'package.json');
const readmePath = join(rootDir, 'README.md');
const marketplaceReadmePath = join(rootDir, 'README.marketplace.md');
const backupPackageJsonPath = join(rootDir, 'package.json.vscode-pack.bak');
const backupReadmePath = join(rootDir, 'README.md.vscode-pack.bak');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const scripts = packageJson.scripts ?? {};

const restoreFiles = () => {
	if (existsSync(backupReadmePath)) {
		rmSync(readmePath, { force: true });
		renameSync(backupReadmePath, readmePath);
	}

	if (existsSync(backupPackageJsonPath)) {
		renameSync(backupPackageJsonPath, packageJsonPath);
	}
};

try {
	copyFileSync(packageJsonPath, backupPackageJsonPath);
	copyFileSync(readmePath, backupReadmePath);

	packageJson.preview = false;
	delete packageJson.enabledApiProposals;
	writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);

	copyFileSync(marketplaceReadmePath, readmePath);

	scripts['vscode:pack:dev'] = scripts['vscode:pack:dev'] ?? 'npm run clean:build && tsc --noEmit && node esbuild.js && npx vsce package';
	scripts['vscode:pack'] = 'npm run clean:build && tsc --noEmit && node esbuild.js --production && npx vsce package';
	packageJson.scripts = scripts;
	writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);

	execSync('npm run clean:build && tsc --noEmit && node esbuild.js --production && npx vsce package', {
		stdio: 'inherit',
		cwd: rootDir,
	});
} finally {
	restoreFiles();
}
