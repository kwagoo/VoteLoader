import assert from 'node:assert/strict';
import test from 'node:test';
import { pageNames, readPublicPages, renderEmbeddedModule } from '../scripts/embed-pages.js';

test('the packaged page module is a copy of the public files', () => {
  const pages = readPublicPages();
  assert.deepEqual(Object.keys(pages), pageNames);
  assert.match(pages['index.html'], /Salesforce ballot loader/);
  assert.match(pages['index.html'], /empty normalised entry/);
  assert.match(pages['styles.css'], /max-width: 880px/);
  assert.match(pages['app.js'], /preferences/);

  const source = renderEmbeddedModule(pages);
  assert.match(source, /VOTELOADER_EMBEDDED_PAGES/);
  const json = source.slice(source.indexOf('export const pages = ') + 'export const pages = '.length).replace(/;\s*$/, '');
  const exported = JSON.parse(json);
  assert.equal(exported['index.html'], pages['index.html']);
  assert.equal(exported['app.js'], pages['app.js']);
  assert.equal(exported['styles.css'], pages['styles.css']);
});
