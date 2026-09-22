/**
 * Tests for environment-driven config, focused on how a container host's
 * ``PORT`` interacts with the dashboard's own ``WEB_*`` knobs.
 *
 * Getting this wrong is what made Render scan every port and find nothing: the
 * process bound 8080 regardless of the injected ``PORT``, and the dashboard was
 * skipped entirely unless ``WEB_ENABLED`` happened to be set.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resolveWebConfig, type Env } from '../hera/config';

test('a host-injected PORT is bound and enables the dashboard', () => {
  const web = resolveWebConfig({ PORT: '10000' });
  assert.equal(web.enabled, true);
  assert.equal(web.port, 10000);
  assert.equal(web.host, '0.0.0.0');
});

test('PORT wins over WEB_PORT when both are set', () => {
  const web = resolveWebConfig({ PORT: '10000', WEB_PORT: '8080' });
  assert.equal(web.port, 10000);
});

test('WEB_PORT is used when the host injects no PORT', () => {
  const web = resolveWebConfig({ WEB_PORT: '9000', WEB_ENABLED: 'true' });
  assert.equal(web.port, 9000);
});

test('without PORT or WEB_ENABLED nothing is served', () => {
  const web = resolveWebConfig({});
  assert.equal(web.enabled, false);
  assert.equal(web.port, 8080);
});

test('an explicit WEB_ENABLED=false turns the dashboard off even with PORT', () => {
  const web = resolveWebConfig({ PORT: '10000', WEB_ENABLED: 'false' });
  assert.equal(web.enabled, false);
  assert.equal(web.port, 10000);
});

test('an explicit WEB_ENABLED=true serves the dashboard without PORT', () => {
  const web = resolveWebConfig({ WEB_ENABLED: 'true' });
  assert.equal(web.enabled, true);
  assert.equal(web.port, 8080);
});

test('WEB_BIND_HOST overrides the bind interface', () => {
  assert.equal(resolveWebConfig({ PORT: '1', WEB_BIND_HOST: '127.0.0.1' }).host, '127.0.0.1');
});

test('a blank or non-numeric PORT falls back to WEB_PORT then 8080', () => {
  assert.equal(resolveWebConfig({ PORT: '', WEB_PORT: '9000' } as Env).port, 9000);
  assert.equal(resolveWebConfig({ PORT: 'abc' }).port, 8080);
});
