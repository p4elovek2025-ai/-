import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const files = ['src/App.tsx','src/main.tsx','server/src/index.ts'];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${file}: ${errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`);
  assert.ok(!source.includes('\\n'), `${file} contains escaped newline artifacts`);
}
const schema = fs.readFileSync('server/prisma/schema.prisma','utf8');
for (const model of ['WorldBossSpawn','WorldBossContribution','PlayerDuel','GuildRaid','GuildRaidContribution','WorldActivity']) assert.match(schema, new RegExp(`model ${model} \\{`));
const server = fs.readFileSync('server/src/index.ts','utf8');
for (const route of ['/api/clans/raid','/api/clans/raid/attack','/api/clans/raid/claim','/api/leaderboard','/api/world/boss/attack','/api/world/duels/strike']) assert.ok(server.includes(route), `missing route ${route}`);
assert.ok(server.includes('claim.count !== 1'), 'raid claim must be one-time/atomic');
console.log('Static smoke checks passed: TS/TSX syntax, escaped-newline scan, Prisma model presence, API route presence, one-time raid claim guard.');
