import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as importer from '../web/js/import-totp.js';
const uri='otpauth://totp/Example%3Aalice?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60';
test('creates one plain-text entry per account, preserving provisioning parameters and skipping existing secrets',()=>{
 const plan=importer.prepareTotpImport(uri+'\n'+uri,[]);
 assert.equal(plan.entries.length,1);assert.equal(plan.skipped,1);
 assert.equal(plan.entries[0],'#2fa\nExample:alice\n'+uri);
 assert.equal(importer.prepareTotpImport(uri,[{kind:'entry',text:'totp: '+uri}]).entries.length,0);
 assert.equal(importer.prepareTotpImport(uri,[{kind:'entry',text:uri,deletedAt:'yesterday'}]).entries.length,1);
});
test('rejects invalid lines without echoing their secrets or importing a partial file',()=>{
 assert.throws(()=>importer.prepareTotpImport(uri+'\notpauth://hotp/a?secret=PRIVATE',[]),e=>e.message==='第 2 行不是有效的 TOTP 配置');
});
