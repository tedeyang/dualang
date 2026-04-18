import { execSync } from 'child_process';
import path from 'path';

export default function globalSetup() {
  console.log('[global-setup] Building extension...');
  execSync('npm run build', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
}
