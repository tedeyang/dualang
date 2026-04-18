import * as esbuild from 'esbuild';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: isDev ? 'inline' : false,
  target: 'chrome120',
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    entryPoints: ['src/content/index.ts'],
    outfile: 'content.js',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: ['src/background/index.ts'],
    outfile: 'background.js',
    format: 'iife',
  },
];

if (isWatch) {
  const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('Watching for changes...');
} else {
  await Promise.all(configs.map(c => esbuild.build(c)));
}
