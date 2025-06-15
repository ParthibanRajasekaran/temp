
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
    'ref_lookup_duration': ['p(50)<1000', 'p(75)<1500', 'p(95)<2000', 'p(99)<3000'],
    'http_reqs': ['count >= 20'],
    'ref_direct_debit_requests': ['count == 20']
  },
};

// Step 1: Setup phase — runs once
export function setup() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/credit-cards/uk/ApplicationDirectDebits?$top=200`, {
    headers: HEADERS,
  });
  const duration = Date.now() - start;
  setupDuration.add(duration);

  if (res.status !== 200) {
    console.error(`Failed to fetch initial reference IDs: ${res.status}`);
    return [];
  }

  let json = null;
  try {
    json = res.json();
  } catch (e) {
    console.error('Failed to parse JSON in setup():', e.message);
    return [];
  }

  if (!json || !json.value || !Array.isArray(json.value)) {
    console.error('Response JSON is not as expected:', JSON.stringify(json));
    return [];
  }

  const allIds = json.value.map(item => item.ReferenceId);
  const shuffled = allIds.sort(() => 0.5 - Math.random());

  return shuffled.slice(0, 20);
}

// Step 2: VU logic — runs for each virtual user
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
    refLookupDuration.add(res.timings.duration);
    refRequests.add(1);

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
