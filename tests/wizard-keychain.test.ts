import fs from 'fs';
import { expect, it } from 'vitest';
const script = fs.readFileSync('public/js/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
it('offers keychain migration without environment-variable controls', () => {
  expect(html).toContain('Protect saved passwords');
  expect(html).toContain('keychainNotice');
  expect(html + script).not.toMatch(/FromEnv|envVarName|Do not save/);
});
it('keeps blank SMTP edit passwords absent while submitting explicit replacements', () => {
  const source = script.slice(script.indexOf('function addSmtpSettings('), script.indexOf('// Handle account form submission'));
  const fields: Record<string, any> = { enableSmtp: { checked: true }, smtpHost: { value: 'smtp.example.invalid' }, smtpPort: { value: '587' }, smtpSecure: { checked: false }, smtpSameAuth: { checked: false }, smtpUser: { value: 'fixture' }, smtpPassword: { value: '' } };
  const apply = new Function('document', source + '; return addSmtpSettings;')({ getElementById: (id: string) => fields[id] });
  const first: any = {};
  apply(first, true);
  expect(first.smtp).not.toHaveProperty('password');
  fields.smtpPassword.value = 'synthetic-new';
  const second: any = {};
  apply(second, true);
  expect(second.smtp.password).toBe('synthetic-new');
});
