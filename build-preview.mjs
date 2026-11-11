import { readFileSync, writeFileSync } from 'node:fs';

const readSource = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const scripts = [];
const page = readSource('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${readSource('styles.css')}\n</style>`)
  .replace(/^\s*<script defer src="([^\"]+)"><\/script>$/gm, (_tag, file) => {
    scripts.push(`<script>\n${readSource(file).replace(/<\/script/gi, '<\\/script')}\n</script>`);
    return '';
  })
  .replace('</body>', () => `${scripts.join('\n')}\n</body>`);

writeFileSync(new URL('../Fíggjarætlan.html', import.meta.url), page);
