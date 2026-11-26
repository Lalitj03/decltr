// A realistic, reproducible big window: tabs from about 20 topics, some one-off tabs and some
// duplicates, with the true topic of every tab so results can be scored.
const TOPICS = {
  'Lisbon trip': [
    ['www.google.com/travel/flights', 'Flights to Lisbon {d}'], ['www.booking.com/hotel/pt/{s}', '{S} Hotel Lisbon | Booking.com'],
    ['www.tripadvisor.com/Attraction_Review-{s}', '{S} - Lisbon - Tripadvisor'], ['www.timeout.com/lisbon/{s}', 'The best {s} in Lisbon'],
    ['www.airbnb.com/rooms/{n}', 'Alfama apartment with view - Airbnb'], ['maps.google.com/lisbon/{s}', '{S}, Lisbon - Google Maps'],
  ],
  'React app': [
    ['react.dev/reference/react/{s}', '{s} – React'], ['github.com/acme/web/pull/{n}', 'Fix {s} rendering by dev · Pull Request #{n} · acme/web'],
    ['stackoverflow.com/questions/{n}/{s}', 'useEffect runs twice with {s} - Stack Overflow'], ['vitejs.dev/guide/{s}', '{S} | Vite'],
    ['github.com/acme/web/issues/{n}', '{S} breaks on Safari · Issue #{n} · acme/web'],
  ],
  'Recipes': [
    ['www.seriouseats.com/{s}-recipe', 'The Best {S} Recipe'], ['www.bonappetit.com/recipe/{s}', '{S} Recipe | Bon Appétit'],
    ['cooking.nytimes.com/recipes/{n}-{s}', '{S} Recipe - NYT Cooking'], ['www.kingarthurbaking.com/recipes/{s}', '{S} | King Arthur Baking'],
  ],
  'Job search': [
    ['www.linkedin.com/jobs/view/{n}', 'Senior Frontend Engineer at {S} | LinkedIn'], ['boards.greenhouse.io/{s}/jobs/{n}', 'Job Application for Staff Engineer at {S}'],
    ['www.glassdoor.com/Reviews/{s}-reviews', '{S} Reviews | Glassdoor'], ['www.levels.fyi/companies/{s}/salaries', '{S} Salaries | Levels.fyi'],
  ],
  'Home renovation': [
    ['www.homedepot.com/p/{s}/{n}', '{S} - The Home Depot'], ['www.houzz.com/photos/{s}', '{S} kitchen ideas - Houzz'],
    ['www.youtube.com/watch?v=reno{n}', 'How to install {s} yourself - YouTube'], ['www.angi.com/articles/{s}-cost', 'How Much Does {S} Cost? | Angi'],
  ],
  'ML papers': [
    ['arxiv.org/abs/2{n}', '[2{n}] Efficient {S} for Large Language Models'], ['paperswithcode.com/method/{s}', '{S} Explained | Papers With Code'],
    ['huggingface.co/papers/2{n}', 'Paper page - Scaling {S}'], ['distill.pub/2020/{s}', 'Visualizing {S}'],
  ],
  'Laptop shopping': [
    ['www.apple.com/shop/buy-mac/{s}', 'Buy MacBook {S} - Apple'], ['www.rtings.com/laptop/reviews/{s}', '{S} Laptop Review - RTINGS.com'],
    ['www.amazon.com/dp/B0{n}', '{S} 14-inch Laptop, 32GB RAM : Amazon.com'], ['www.notebookcheck.net/{S}-review.{n}.0.html', '{S} review - Notebookcheck'],
  ],
  'Taxes': [
    ['www.irs.gov/forms-pubs/{s}', 'About Form {S} | Internal Revenue Service'], ['turbotax.intuit.com/tax-tips/{s}', '{S} deduction explained - TurboTax'],
    ['www.nerdwallet.com/article/taxes/{s}', 'Tax {S}: What to Know - NerdWallet'],
  ],
  'Wedding planning': [
    ['www.theknot.com/marketplace/{s}', '{S} - Wedding Venues - The Knot'], ['www.zola.com/wedding-planning/{s}', 'Wedding {S} checklist | Zola'],
    ['www.etsy.com/listing/{n}/{s}', 'Custom {s} wedding invitations - Etsy'],
  ],
  'Kubernetes': [
    ['kubernetes.io/docs/concepts/{s}', '{S} | Kubernetes'], ['github.com/kubernetes/kubernetes/issues/{n}', 'kubelet {s} leak · Issue #{n}'],
    ['helm.sh/docs/{s}', 'Helm | {S}'], ['learnk8s.io/{s}', 'A visual guide to {S} in Kubernetes'],
  ],
  'Fitness': [
    ['www.strava.com/activities/{n}', 'Morning {S} Run | Strava'], ['www.runnersworld.com/training/{s}', '{S} training plan for beginners'],
    ['www.reddit.com/r/running/comments/{n}', 'Tips for {s} on long runs : r/running'],
  ],
  'Rust learning': [
    ['doc.rust-lang.org/book/{s}.html', '{S} - The Rust Programming Language'], ['docs.rs/{s}/latest', '{s} - Rust'],
    ['users.rust-lang.org/t/{s}/{n}', 'How do I {s} with lifetimes? - Rust Users Forum'],
  ],
  'Gardening': [
    ['www.rhs.org.uk/plants/{s}', '{S} / RHS Gardening'], ['www.gardenersworld.com/how-to/{s}', 'How to grow {s} | Gardeners World'],
  ],
  'Car buying': [
    ['www.edmunds.com/{s}/2025/review', '2025 {S} Review | Edmunds'], ['www.kbb.com/{s}/2024', '2024 {S} Values | Kelley Blue Book'],
    ['www.cars.com/vehicledetail/{n}', 'Used 2023 {S} for sale - Cars.com'],
  ],
  'News': [
    ['www.bbc.com/news/world-{n}', '{S} talks resume as leaders meet - BBC News'], ['www.nytimes.com/2026/11/{s}.html', 'Opinion | The {S} Debate - The New York Times'],
    ['www.theguardian.com/world/2026/{s}', '{S} protests spread | World news | The Guardian'],
  ],
  'Music': [
    ['www.youtube.com/watch?v=mu{n}', '{S} - Live at Glastonbury (Full Set) - YouTube'], ['open.spotify.com/album/{n}', '{S} - Album by Various Artists | Spotify'],
  ],
  'Photography': [
    ['www.dpreview.com/reviews/{s}', '{S} Review: Digital Photography Review'], ['petapixel.com/2026/{s}', 'How to shoot {s} at night | PetaPixel'],
  ],
  'Kids school': [
    ['classroom.google.com/c/{n}', 'Grade 4 {S} | Google Classroom'], ['www.khanacademy.org/math/{s}', '{S} | Khan Academy'],
  ],
  'Health': [
    ['www.mayoclinic.org/diseases-conditions/{s}', '{S} - Symptoms and causes - Mayo Clinic'], ['www.zocdoc.com/dentists/{s}', 'Best {S} dentists near you | Zocdoc'],
  ],
  'Budget spreadsheet': [
    ['docs.google.com/spreadsheets/d/{n}', '{S} budget 2026 - Google Sheets'], ['www.ynab.com/blog/{s}', 'How to budget for {s} | YNAB'],
  ],
};
const WORDS = ['alpha', 'harbor', 'citrus', 'granite', 'velvet', 'summit', 'meadow', 'copper', 'lantern', 'orbit', 'willow', 'ember',
  'quartz', 'cedar', 'pixel', 'nectar', 'tundra', 'saffron', 'cobalt', 'juniper', 'marble', 'falcon', 'oasis', 'pepper'];
const ONE_OFFS = [
  ['www.wikipedia.org/wiki/{S}', '{S} - Wikipedia'], ['mail.google.com/mail/u/0/#inbox/{n}', 'Inbox (3) - Gmail'], ['www.weather.com/today/{s}', 'Weather today - {S}'],
  ['www.imdb.com/title/tt{n}', '{S} (2025) - IMDb'], ['translate.google.com/?text={s}', 'Google Translate'], ['www.speedtest.net/result/{n}', 'Speedtest by Ookla'],
];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** n tabs, about 4% one-offs and 3% duplicates, in a shuffled but "bursty" order like a real window. */
export function makeWindow(n, seed = 7) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const fill = (tpl) => {
    const w = pick(WORDS);
    return tpl.replaceAll('{s}', w).replaceAll('{S}', w[0].toUpperCase() + w.slice(1)).replaceAll('{n}', String(1000 + Math.floor(r() * 90000))).replaceAll('{d}', 'Dec 12');
  };
  const names = Object.keys(TOPICS);
  const tabs = [];
  while (tabs.length < n) {
    const roll = r();
    if (roll < 0.04) {
      const [u, t] = pick(ONE_OFFS);
      tabs.push({ url: `https://${fill(u)}`, title: fill(t), topic: null });
    } else if (roll < 0.07 && tabs.length > 10) {
      tabs.push({ ...tabs[Math.floor(r() * tabs.length)] });
    } else {
      // People open related tabs in bursts: 1 to 6 tabs of the same topic in a row.
      const topic = pick(names);
      for (let k = 1 + Math.floor(r() * 6); k > 0 && tabs.length < n; k--) {
        const [u, t] = pick(TOPICS[topic]);
        tabs.push({ url: `https://${fill(u)}`, title: fill(t), topic });
      }
    }
  }
  return tabs.map((t, i) => ({ ...t, id: 5000 + i }));
}

/** How good a set of group actions is against the true topics. */
export function score(window, actions) {
  const topicOf = new Map(window.map((t) => [t.id, t.topic]));
  const groups = actions.filter((a) => a.type === 'group');
  const grouped = new Set(groups.flatMap((g) => g.tabIds));
  const topical = window.filter((t) => t.topic);
  let pure = 0;
  const perTopic = new Map();
  for (const g of groups) {
    const counts = new Map();
    for (const id of g.tabIds) counts.set(topicOf.get(id), (counts.get(topicOf.get(id)) ?? 0) + 1);
    const [top, c] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    pure += c;
    if (top) perTopic.set(top, (perTopic.get(top) ?? 0) + 1);
  }
  return {
    tabs: window.length,
    groups: groups.length,
    coverage: `${Math.round((topical.filter((t) => grouped.has(t.id)).length / topical.length) * 100)}%`,
    purity: grouped.size ? `${Math.round((pure / grouped.size) * 100)}%` : 'n/a',
    topicsSplitAcrossGroups: [...perTopic.values()].filter((v) => v > 1).length,
  };
}
