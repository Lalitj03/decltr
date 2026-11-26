import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseProviderForKey, createKeySource, detectKeyType, resolveProvider } from '../server/src/provider.js';

// Obviously fake, but shaped like the real formats.
const GEMINI = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const VERTEX = 'AQ.FakeVertexKeyFakeVertexKeyFakeVertex12345';

function fakeKeychain(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { find: 0 };
  return {
    store,
    calls,
    find: async (service, account) => (calls.find++, store.get(`${service}/${account}`) ?? null),
    add: async (service, account, key) => void store.set(`${service}/${account}`, key),
  };
}

test('the kind of key is recognised from its format', () => {
  assert.equal(detectKeyType(GEMINI), 'gemini');
  assert.equal(detectKeyType(VERTEX), 'vertex');
  for (const other of ['', 'sk-' + 'a'.repeat(40), 'AIza-too-short', 'AQ.short', 'ya29.' + 'a'.repeat(40), null, undefined, 42]) {
    assert.equal(detectKeyType(other), null, String(other));
  }
});

test('saving a key: the type is worked out, or it can be stated, and a mix-up is called out', () => {
  assert.deepEqual(chooseProviderForKey(GEMINI), { provider: 'gemini', detected: 'gemini', warning: null });
  assert.deepEqual(chooseProviderForKey(VERTEX), { provider: 'vertex', detected: 'vertex', warning: null });
  assert.equal(chooseProviderForKey(GEMINI, 'gemini').warning, null, 'agreeing is not a warning');

  // Stating the type always wins, because formats may change, but the user is told about the mismatch.
  const mismatch = chooseProviderForKey(GEMINI, 'vertex');
  assert.equal(mismatch.provider, 'vertex');
  assert.match(mismatch.warning, /looks like a Gemini API \(AI Studio\) key/);

  // An unrecognised format needs the type stated, and the error says how.
  const unknown = 'x'.repeat(40);
  assert.throws(() => chooseProviderForKey(unknown), /npm run set-key vertex.*npm run set-key gemini/s);
  assert.equal(chooseProviderForKey(unknown, 'gemini').provider, 'gemini');
  assert.throws(() => chooseProviderForKey(GEMINI, 'openai'), /must be one of/);
});

test('which provider is used: setting, then environment key, then stored keys, then the default', async () => {
  const none = fakeKeychain();
  assert.deepEqual(await resolveProvider({}, none), { provider: 'vertex', source: 'default' });

  assert.equal((await resolveProvider({}, fakeKeychain({ 'decltr/gemini-api-key': GEMINI }))).provider, 'gemini', 'only a Gemini key stored');
  assert.equal((await resolveProvider({}, fakeKeychain({ 'decltr/vertex-api-key': VERTEX }))).provider, 'vertex', 'only a Vertex key stored');
  assert.equal(
    (await resolveProvider({}, fakeKeychain({ 'decltr/vertex-api-key': VERTEX, 'decltr/gemini-api-key': GEMINI }))).provider,
    'vertex',
    'both stored: Vertex AI wins',
  );
  assert.equal(
    (await resolveProvider({}, fakeKeychain({ 'declt/gemini-api-key': GEMINI }))).provider,
    'gemini',
    'a key saved before the product was renamed still counts',
  );

  assert.equal((await resolveProvider({ DECLTR_API_KEY: GEMINI }, none)).provider, 'gemini', 'a key in the environment decides by its format');
  assert.equal((await resolveProvider({ DECLTR_API_KEY: VERTEX }, none)).provider, 'vertex');
  assert.equal((await resolveProvider({ DECLTR_API_KEY: 'x'.repeat(40) }, none)).provider, 'vertex', 'unrecognised: the default');

  const both = fakeKeychain({ 'decltr/vertex-api-key': VERTEX, 'decltr/gemini-api-key': GEMINI });
  assert.deepEqual(await resolveProvider({ DECLTR_PROVIDER: 'gemini' }, both), { provider: 'gemini', source: 'DECLTR_PROVIDER' }, 'the setting beats any key');
  assert.equal((await resolveProvider({ DECLTR_PROVIDER: 'gemini', DECLTR_API_KEY: VERTEX }, both)).provider, 'gemini');
});

test('a key saved after the server started is picked up, with the matching provider, without a restart', async () => {
  const kc = fakeKeychain();
  const config = { provider: 'vertex' };
  const getApiKey = createKeySource(config, { env: {}, keychain: kc });

  assert.equal(await getApiKey(), null, 'no key yet');
  assert.equal(config.provider, 'vertex', 'the default, so messages still make sense');

  await kc.add('decltr', 'gemini-api-key', GEMINI); // what `npm run set-key` does
  assert.equal(await getApiKey(), GEMINI);
  assert.equal(config.provider, 'gemini', 'the server now talks to the Gemini API');
});

test('once found, the key is kept and the keychain is not asked again', async () => {
  const kc = fakeKeychain({ 'decltr/vertex-api-key': VERTEX });
  const getApiKey = createKeySource({ provider: 'vertex' }, { env: {}, keychain: kc });
  assert.equal(await getApiKey(), VERTEX);
  const lookups = kc.calls.find;
  await getApiKey();
  await getApiKey();
  assert.equal(kc.calls.find, lookups, 'cached');
});

test('an environment key works without any keychain, which is how it runs on Windows and Linux', async () => {
  const config = { provider: 'vertex' };
  const getApiKey = createKeySource(config, { env: { DECLTR_API_KEY: GEMINI }, keychain: fakeKeychain() });
  assert.equal(await getApiKey(), GEMINI);
  assert.equal(config.provider, 'gemini');
});
