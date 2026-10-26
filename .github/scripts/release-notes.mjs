// Release notes for the tag in GITHUB_REF_NAME, written to notes.md for `gh release create`.
//
// This runs in the release workflow. It lives in a file rather than inline in the workflow on
// purpose: the notes contain backticks (fenced blocks and `code spans`), and inside a
// double-quoted `run:` string the shell would treat those as command substitution.
import fs from 'node:fs';

const tag = process.env.GITHUB_REF_NAME ?? '';
if (!/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error(`not a version tag: ${JSON.stringify(tag)}`);
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const at = changelog.indexOf(`## [${version}]`);
if (at < 0) {
  console.error(`CHANGELOG.md has no [${version}] section`);
  process.exit(1);
}
const rest = changelog.slice(at);
const end = rest.indexOf('\n## [', 1);
const section = (end < 0 ? rest : rest.slice(0, end)).trim();

const upgrade = [
  '',
  '## Upgrade',
  '',
  '```bash',
  `dsh plugin --profile web add github:GnaneshKunal/dsh-openrouter-plus#${tag}`,
  '```',
  '',
  'or, from the registry, `dsh plugin --profile web add dsh-openrouter-plus`.',
  '',
  'Restart `dsh web` so the relay loads the new host half, then reload the page — the settings',
  'page and the composer chip ship in the browser bundle and only re-evaluate with the document.',
  '',
].join('\n');

fs.writeFileSync('notes.md', `${section}\n${upgrade}`);
console.log(`wrote notes.md for ${tag} (${section.split('\n').length} changelog lines)`);
