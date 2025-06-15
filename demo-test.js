

import http from 'k6/http';
import { check, sleep, group, Trend, Counter } from 'k6';

// Config
const BASE_URL = 'https://ops-snowflake-data-api-qa.clouddqt.uk.xxx.com';
const HEADERS = {
  'X-User-Info': 'autoproc@00duf000000t8xp2aa',
  'Content-Type': 'application/json',
};

// Custom metrics
let setupDuration = new Trend('setup_duration');
let refLookupDuration = new Trend('ref_lookup_duration');
let refRequests = new Counter('ref_direct_debit_requests');

// Options
export let options = {
  vus: 20,
  iterations: 20,
  thresholds: {
    'ref_lookup_duration': ['p(50)<2000', 'p(75)<3000', 'p(95)<4000', 'p(99)<5000'],
    'ref_direct_debit_requests': ['count == 20'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(75)', 'p(95)', 'p(99)'],
};

// Setup: Fetch 200 ReferenceIds
export function setup() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=200`, {
    headers: HEADERS,
  });
  const duration = Date.now() - start;
  setupDuration.add(duration);

  if (res.status !== 200) {
    console.error(`Setup failed. Status: ${res.status}`);
    return [];
  }

  let json = null;
  try {
    json = res.json();
  } catch (err) {
    console.error('Failed to parse JSON in setup():', err.message);
    return [];
  }

  const values = json?.value || [];
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
      const data = res.json();
      check(data, {
        'body has data': (d) => !!d && Array.isArray(d.value) && d.value.length > 0,
      });
    } else {
      console.error('Error response:', res.status, res.body);
      check(null, { 'body has data': () => false });
    }

    sleep(1);
  });
}

// Export summary for HTML reporter
export function handleSummary(data) {
  return {
    'summary.json': JSON.stringify(data),
  };
}
