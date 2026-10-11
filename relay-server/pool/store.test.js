/**
 * Pool store ids carry a colon ("no-frills:M5V" — the app files
 * contributions as chain:region), so aggregates must not come from
 * splitting the store key on ':'.
 */

const { PoolStore } = require('./store');

const WEEK = '2026-W41';
const LATER = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

describe('PoolStore.getAggregates', () => {
  test('finds reports filed under a chain:region store id', () => {
    const store = new PoolStore();
    const meta = { storeId: 'no-frills:M5V', itemName: 'neilson 2% milk 4 l', flyerWeek: WEEK };
    const key = `${meta.storeId}:${meta.itemName}:${WEEK}`;
    store.addReport(key, 5.49, LATER(), meta);
    store.addReport(key, 5.29, LATER(), meta);

    const aggs = store.getAggregates('no-frills:M5V');
    expect(aggs).toHaveLength(1);
    expect(aggs[0]).toMatchObject({ itemName: 'neilson 2% milk 4 l', flyerWeek: WEEK, count: 2 });
    // Neither the chain alone nor another region sees them.
    expect(store.getAggregates('no-frills')).toEqual([]);
    expect(store.getAggregates('no-frills:L0R')).toEqual([]);
  });

  test('item names containing a colon survive', () => {
    const store = new PoolStore();
    const meta = { storeId: 'freshco:M5V', itemName: 'coke: zero 2 l', flyerWeek: WEEK };
    store.addReport(`freshco:M5V:coke: zero 2 l:${WEEK}`, 2.5, LATER(), meta);
    expect(store.getAggregates('freshco:M5V')[0].itemName).toBe('coke: zero 2 l');
  });

  test('keys added without metadata (seed data) still aggregate', () => {
    const store = new PoolStore();
    store.seed([{ key: `loblaws:2% milk 4 l:${WEEK}`, price: 6.49, validTo: LATER() }]);
    expect(store.getAggregates('loblaws')[0]).toMatchObject({ itemName: '2% milk 4 l', flyerWeek: WEEK });
  });
});

describe('pool-server', () => {
  test('files each contribution with its key parts', () => {
    // POST needs a blind-signed token (covered by the relay suites); here,
    // just that the handler hands the store the parts it keyed on.
    const src = require('fs').readFileSync(require.resolve('./pool-server'), 'utf8');
    expect(src).toMatch(/store\.addReport\(key, price, validTo, \{ storeId, itemName: normalizedName, flyerWeek \}\)/);
  });
});
