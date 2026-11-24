// Sets the passwords of the owner and the admin.   npm run set-passwords
// What you type is hidden, is never saved anywhere, and only its scrypt hash goes into the
// database. Run it again at any time to change a password (that also ends old logins).
const { hashPassword, checkPassword, setHash, findUser, LOCKED, OWNER_ID, ADMIN_ID } = require('../db');
const { staffPasswordProblem } = require('../security');

// Reads one line without showing it (a * appears for each character).
function askHidden(question, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    output.write(question);
    let typed = [];
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = (done, value) => { input.off('data', onData); input.setRawMode(false); input.pause(); output.write('\n'); done(value); };
    function onData(text) {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish(resolve, typed.join(''));
        if (ch === '\u0003') return finish(reject, new Error('Stopped. Nothing was changed for this account.'));   // Ctrl + C
        if (ch === '\u007f' || ch === '\b') { if (typed.pop() !== undefined) output.write('\b \b'); }              // Backspace
        else if (ch >= ' ') { typed.push(ch); output.write('*'); }
      }
    }
    input.on('data', onData);
  });
}

async function setOne(title, email, otherEmail, io = {}) {
  const say = (s) => (io.output || process.stdout).write(s + '\n');
  const now = findUser(email).password_hash;
  say(`\n${title}\n  ID: ${email}   (${now === LOCKED ? 'locked, no password yet' : 'already has a password'})`);
  for (;;) {
    const password = await askHidden('  New password (12 or more characters, or just Enter to skip): ', io.input, io.output);
    if (password === '') { say('  Skipped.'); return false; }
    let problem = staffPasswordProblem(password);
    if (!problem && await checkPassword(password, findUser(otherEmail).password_hash)) problem = 'It must be different from the other account.';
    if (problem) { say('  ' + problem + ' Please try again.'); continue; }
    if (await askHidden('  Type it again: ', io.input, io.output) !== password) { say('  Those were not the same. Please try again.'); continue; }
    setHash(email, await hashPassword(password));
    say('  Saved.');
    return true;
  }
}

async function main() {
  if (!process.stdin.isTTY) { console.error('Please run this in a terminal window.'); process.exit(1); }
  console.log('Keep these passwords in a password manager or on paper, not in this project.');
  await setOne('OWNER (you, highest access)', OWNER_ID, ADMIN_ID);
  await setOne('ADMIN (reviews reports)', ADMIN_ID, OWNER_ID);
  console.log('\nDone. You can log in now; no restart is needed.');
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { askHidden, setOne };
