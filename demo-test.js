import http from 'k6/http';
import { check, sleep, group, Trend } from 'k6';

// Config
const BASE_URL = 'https://ops-snowflake-data-api-qa.clouddqt.uk.xxx.com';
const HEADERS = {
  'X-User-Info': 'autoproc@00duf000000t8xp2aa',
  'Content-Type': 'application/json',
};

// Custom metrics
let setupDuration = new Trend('setup_duration');
let refLookupDuration = new Trend('ref_lookup_duration');

// Options
export let options = {
  vus: 20,
  iterations: 20,
  thresholds: {
    'ref_lookup_duration': ['p(50)<1000', 'p(75)<1500', 'p(95)<2000', 'p(99)<3000'],
  },
};

export function setup() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=200`, {
    headers: HEADERS,
  });
  const duration = Date.now() - start;
  setupDuration.add(duration); // log setup request time in ms

  if (res.status !== 200) {
    console.error(`Failed to fetch initial reference IDs: ${res.status}`);
    return [];
  }

  const json = res.json();
  const values = json?.value || [];
  const allIds = values.map((item) => item.ReferenceId);
  const shuffled = allIds.sort(() => 0.5 - Math.random());

  return shuffled.slice(0, 20); // return 20 random IDs
}

export default function (referenceIds) {
  const vuId = __VU - 1;
  const refId = referenceIds[vuId];

  if (!refId) {
    console.error(`No valid ReferenceId for VU ${__VU}`);
    return;
  }

  group(`Fetching direct debit for reference ${refId}`, function () {
    const filter = encodeURIComponent(`ReferenceId eq '${refId}'`);
    const url = `${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=1&$filter=${filter}`;

    const res = http.get(url, { headers: HEADERS });
    refLookupDuration.add(res.timings.duration); // log time of each request

    check(res, {
      'status is 200': (r) => r.status === 200,
    });

    if (res.status === 200) {
      let data = res.json();
      check(data, {
        'body has data': (d) =>
          !!d && Array.isArray(d.value) && d.value.length > 0,
      });
    } else {
      console.error(`Non-200 response:`, res.status, res.body);
      check(null, {
        'body has data': () => false,
      });
    }

    sleep(1);
  });
}
