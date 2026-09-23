/**
 * Tests for bot-level wiring: command registration parity and error reporting.
 *
 * Every command must exist on both front ends with the same arguments, and a
 * failure must reach the user in the same shape regardless of which one they
 * used. These run against the real loader and the real definitions, not doubles.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';
import { GatewayIntentBits, type Message } from 'discord.js';

import {
  buildSlashData,
  matchPrefix,
  readPrefixArgs,
  usage,
  PrefixArgumentError,
} from '../hera/framework/register';
import { loadCommands } from '../hera/framework/registry';
import {
  CATEGORIES,
  groupedCommands,
  paginate,
  categoryEmbed,
  detailEmbed,
  MAX_FIELDS_PER_PAGE,
} from '../hera/commands/help/directory';
import type { CommandDefinition, CommandServices } from '../hera/framework/types';
import { config } from '../hera/config';
import { HeraBot } from '../hera/bot';
import { Dashboard } from '../dashboard/server';

function loadAll(): CommandDefinition[] {
  const { commands, failures } = loadCommands(join(__dirname, '..', 'hera', 'commands'));
  assert.deepEqual(failures, [], `command files failed to load: ${failures.map(([p]) => p).join(', ')}`);
  return commands;
}

function fakeMessage(guild?: { members: { cache: Map<string, unknown> } }): Message {
  return { guild } as unknown as Message;
}

// ------------------------------------------------------------------ registration

test('every command registers on both front ends', () => {
  const commands = loadAll();
  const names = commands.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, 'duplicate command names');

  // Every definition yields a slash payload with the same name and options.
  for (const definition of commands) {
    const payload = buildSlashData(definition);
    assert.equal(payload.name, definition.name);
    assert.equal(payload.description.length > 0, true);
    assert.equal((payload.options ?? []).length, (definition.args ?? []).length);
    assert.ok(/^[a-z0-9_-]{1,32}$/.test(payload.name), `bad slash name: ${payload.name}`);
  }
});

/**
 * Discord rejects a command whose optional options precede a required one with
 * a 50035 Invalid Form Body. The bot syncs commands at startup, and a failure
 * there throws out of ``start()``, which takes the process down — and the
 * dashboard with it in the in-process web mode. So this rule is a boot
 * precondition, not a nicety.
 */
test('required options are declared before optional ones', () => {
  for (const definition of loadAll()) {
    const options = (buildSlashData(definition).options ?? []) as { name: string; required?: boolean }[];
    let seenOptional = false;
    for (const option of options) {
      if (option.required === true && seenOptional) {
        assert.fail(
          `${definition.name}: required option '${option.name}' follows an optional one`,
        );
      }
      if (option.required !== true) seenOptional = true;
    }
  }
});

test('a choice argument with no default is required', () => {
  // An optional choice falls back to undefined when omitted, which either leaks
  // the word "undefined" into the result or throws inside the game. Every
  // casino choice argument picks a side, so all of them must be required.
  for (const definition of loadAll()) {
    if (definition.category !== 'casino') continue;
    for (const arg of definition.args ?? []) {
      if (arg.choices) {
        assert.equal(arg.required, true, `${definition.name}: choice '${arg.name}' is optional`);
      }
    }
  }
});

test('prefix arguments mirror the slash argument list', () => {
  for (const definition of loadAll()) {
    const tokens = (definition.args ?? []).map((arg) => {
      if (arg.type === 'integer' || arg.type === 'number') return '1';
      if (arg.type === 'user') return '<@123456789012345678>';
      return arg.choices ? arg.choices[0].value : 'x';
    });
    const args = readPrefixArgs(definition, tokens, fakeMessage());
    for (const arg of definition.args ?? []) {
      if (arg.required) assert.ok(arg.name in args, `${definition.name}: missing ${arg.name}`);
    }
  }
});

test('required arguments are enforced on the prefix path', () => {
  for (const definition of loadAll()) {
    const required = (definition.args ?? []).filter((arg) => arg.required);
    if (required.length === 0) continue;
    assert.throws(
      () => readPrefixArgs(definition, [], fakeMessage()),
      PrefixArgumentError,
      `${definition.name} accepted no arguments despite having required options`,
    );
  }
});

test('prefix usage lines name every argument', () => {
  for (const definition of loadAll()) {
    const line = usage(definition, config.prefix);
    assert.ok(line.includes(`${config.prefix}${definition.name}`));
    for (const arg of definition.args ?? []) {
      assert.ok(line.includes(arg.name), `${definition.name}: usage omits ${arg.name}`);
    }
  }
});

test('choice commands validate their values locally', () => {
  const limit = loadAll().find((command) => command.name === 'limit')!;
  const side = limit.args!.find((arg) => arg.name === 'side')!;
  const offered = side.choices!.map((choice) => choice.value);
  assert.deepEqual([...offered].sort(), ['buy', 'cover', 'sell', 'short']);

  assert.throws(
    () => readPrefixArgs(limit, ['yolo', 'NOVA', '1', '100'], fakeMessage()),
    PrefixArgumentError,
  );
  const args = readPrefixArgs(limit, ['sell', 'NOVA', '1', '100'], fakeMessage());
  assert.equal(args.side, 'sell');
});

test('matchPrefix finds the command and its tokens', () => {
  const definition = loadAll().find((command) => command.name === 'quote')!;
  const commands = new Map([[definition.name, { definition, handler: async () => {} }]]);
  const matched = matchPrefix(`${config.prefix}quote NOVA extra`, config.prefix, commands);
  assert.ok(matched);
  assert.equal(matched.command.definition.name, 'quote');
  assert.deepEqual(matched.tokens, ['NOVA', 'extra']);
});

test('matchPrefix ignores non-commands and unknown names', () => {
  const commands = new Map([
    ['quote', { definition: loadAll()[0], handler: async () => {} }],
  ]);
  assert.equal(matchPrefix('just chatting', config.prefix, commands), null);
  assert.equal(matchPrefix(`${config.prefix}nosuch`, config.prefix, commands), null);
  assert.equal(matchPrefix(config.prefix, config.prefix, commands), null);
});

// ------------------------------------------------------------------- directory

test('the help directory groups every command', () => {
  const commands = loadAll();
  const index = { commands: new Map(commands.map((command) => [command.name, command])) };
  const buckets = groupedCommands(index);
  const listed = new Set(
    Object.values(buckets)
      .flat()
      .map((command) => command.name),
  );
  assert.deepEqual([...listed].sort(), commands.map((command) => command.name).sort());
  for (const category of Object.keys(buckets)) {
    assert.ok(category in CATEGORIES, `unknown category ${category}`);
  }
});

test('every help page fits the embed field limit', () => {
  const commands = loadAll();
  const index = { commands: new Map(commands.map((command) => [command.name, command])) };
  const pages = paginate(groupedCommands(index));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const embed = categoryEmbed(index, page.category, page.entries, {
      continued: page.continued,
      prefix: config.prefix,
    });
    assert.ok(embed.data.fields!.length <= 25);
  }
});

test('a category too long for one page is split', () => {
  const commands = loadAll();
  const index = { commands: new Map(commands.map((command) => [command.name, command])) };
  const pages = paginate(groupedCommands(index));
  const market = pages.filter((page) => page.category === 'market');
  assert.ok(market.length > 1, 'the market category should need several pages');
  assert.ok(pages.every((page) => page.entries.length <= MAX_FIELDS_PER_PAGE));
  // Only the continuation is marked as such.
  assert.equal(market[0].continued, false);
  assert.ok(market.slice(1).every((page) => page.continued === true));
});

test('help detail lists both spellings and the choices', () => {
  const commands = loadAll();
  const index = { commands: new Map(commands.map((command) => [command.name, command])) };
  const embed = detailEmbed(index, 'limit', config.prefix)!;
  const fields = new Map(embed.data.fields!.map((field) => [field.name, field.value]));
  assert.ok(fields.get('Prefix')!.includes(`${config.prefix}limit`));
  assert.ok(fields.get('Slash')!.includes('/limit'));
  assert.ok(fields.get('Parameters')!.includes('one of: buy, sell, short, cover'));
});

test('help detail returns nothing for an unknown command', () => {
  const index = { commands: new Map<string, CommandDefinition>() };
  assert.equal(detailEmbed(index, 'definitely-not-a-command', config.prefix), null);
});

// --------------------------------------------------------------- service facade

test('the service facade exposes the live command index', () => {
  const commands = loadAll();
  const index = { commands: new Map(commands.map((command) => [command.name, command])) };
  // Shape check only: this is what bot.ts hands to every command body.
  const services = { commandIndex: index } as unknown as CommandServices;
  assert.equal(services.commandIndex.commands.size, commands.length);
});

test('the bot subscribes to the intents prefix commands need', () => {
  // Prefix commands arrive as MESSAGE_CREATE, which Discord only delivers when
  // GuildMessages is requested. MessageContent alone is not enough -- it fills in
  // the text of an event that GuildMessages gates. Requesting only the latter
  // boots and serves slash commands while every typed command stays invisible.
  const bot = new HeraBot({}, ':memory:');
  const intents = bot.options.intents;
  assert.equal(intents.has(GatewayIntentBits.GuildMessages), true);
  assert.equal(intents.has(GatewayIntentBits.MessageContent), true);
  void bot.shutdown();
});

test('the bot hands its live services to the dashboard', async () => {
  // index.ts serves the dashboard from the bot's own database and market service
  // when WEB_ENABLED=true, so those two fields must stay public and shared.
  const bot = new HeraBot({}, ':memory:');
  try {
    assert.ok(bot.db);
    assert.ok(bot.market);
    const dashboard = new Dashboard({ guildId: '424242', db: bot.db, market: bot.market });
    await dashboard.start('127.0.0.1', 0);
    const address = (dashboard as unknown as { server: { address(): { port: number } } })
      .server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    await dashboard.stop();
    // The dashboard borrowed the database, so the bot can still use it.
    bot.market.tick('424242');
    assert.equal(bot.market.snapshot('424242').tick, 1);
  } finally {
    await bot.shutdown();
  }
});
