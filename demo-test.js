

import http from 'k6/http';
import { check, sleep, group, Trend, Counter } from 'k6';

// Config
const BASE_URL = 'https://ops-snowflake-data-api-qa.clouddqt.uk.xxx.com';
const HEADERS = {
  'X-User-Info': 'autoproc@00duf000000t8xp2aa'
};

// Custom metrics
let setupDuration = new Trend('setup_duration');
let refLookupDuration = new Trend('ref_lookup_duration');
let refRequests = new Counter('ref_direct_debit_requests');

export let options = {
  vus: 20,
  iterations: 20,
  thresholds: {
    'ref_lookup_duration': ['p(50)<2000', 'p(75)<3000', 'p(95)<4000', 'p(99)<5000'],
    'setup_duration': ['p(50)<2000'],
    'ref_direct_debit_requests': ['count == 20'],
    'http_reqs': ['count >= 21'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(75)', 'p(95)', 'p(99)'],
};

// Setup: Fetch 200 ReferenceIds with hardened JSON handling
export function setup() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=200`, {
    headers: HEADERS,
  });
  const duration = Date.now() - start;
  setupDuration.add(duration);

  if (res.status !== 200) {
    console.error(`Setup failed. Status: ${res.status}`);
    console.error('Body:', res.body);
    return [];
  }

  let json = null;
  let values = [];

  try {
    json = res.json();

    if (!json || typeof json !== 'object') throw new Error('Parsed JSON is not an object');
    if (!Array.isArray(json.value)) throw new Error('json.value is not an array');

    values = json.value;
  } catch (err) {
    console.error('Setup failed:', err.message);
    console.error('Raw response body:', res.body);
    return [];
  }

  const allIds = values.map(item => item.ReferenceId);
  const shuffled = allIds.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 20);
}

// Main test for each VU
export default function (referenceIds) {
  const vuId = __VU - 1;
  const refId = referenceIds[vuId];

  if (!refId) {
    console.error(`No ReferenceId for VU ${__VU}`);
    return;
  }

  group(`Lookup for ReferenceId ${refId}`, () => {
    const filter = encodeURIComponent(`ReferenceId eq '${refId}'`);
    const url = `${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=1&$filter=${filter}`;

    const res = http.get(url, { headers: HEADERS });
    refLookupDuration.add(res.timings.duration);
    refRequests.add(1);

    check(res, {
      'status is 200': (r) => r.status === 200,
    });

    if (res.status === 200) {
      try {
        const data = res.json();
        check(data, {
          'body has data': (d) => !!d && Array.isArray(d.value) && d.value.length > 0,
        });
      } catch (e) {
        console.error('Error parsing JSON body:', e.message);
        check(null, { 'body has data': () => false });
      }
    } else {
      console.error('Non-200 response:', res.status, res.body);
      check(null, { 'body has data': () => false });
    }

    sleep(1);
  });
}

// Export summary for optional HTML report generation
export function handleSummary(data) {
  return {
    'summary.json': JSON.stringify(data),
  };
}
