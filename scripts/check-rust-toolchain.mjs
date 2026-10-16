import { spawnSync } from 'node:child_process';

// 只预检本机工具链，不在构建入口隐式下载或修改开发环境。
const missing = ['cargo', 'rustc'].filter((tool) => {
  const result = spawnSync(tool, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.error || result.status !== 0;
});

if (missing.length > 0) {
  console.error(`Rust toolchain is unavailable (${missing.join(', ')} not found or not runnable).`);
  console.error('Install Rust stable with rustup from https://rustup.rs/, then restart the terminal and run this command again.');
  if (process.platform === 'darwin') {
    console.error('On macOS, also install Xcode Command Line Tools with: xcode-select --install');
  } else if (process.platform === 'win32') {
    console.error('On Windows, install the Visual Studio C++ Build Tools workload required by the MSVC Rust target.');
  }
  process.exit(1);
}
