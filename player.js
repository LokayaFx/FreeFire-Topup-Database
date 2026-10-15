function apiBase() {
  return (process.env.FF_API_URL || 'https://freefire-idinfo.vercel.app').replace(/\/+$/, '');
}

async function lookupPlayer(uid, region, timeoutMs = 15000, retries = 2) {
  const id = String(uid || '').trim();
  if (!/^\d{5,15}$/.test(id)) throw new Error('Player UID must be 5-15 digits.');
  const url = `${apiBase()}/player-info?uid=${encodeURIComponent(id)}${region ? `&region=${encodeURIComponent(String(region).toUpperCase())}` : ''}`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = new Error('API busy (warming up). Try again in a few seconds.');
      } else if (res.status === 404) {
        throw new Error('Player not found.');
      } else if (!res.ok) {
        throw new Error(`Lookup failed (HTTP ${res.status}).`);
      } else {
        const data = await res.json();
        const b = data.basicInfo || {};
        if (!b.nickname) throw new Error('Player not found.');
        const clan = data.clanBasicInfo || {};
        const social = data.socialInfo || {};
        const media = data.mediaInfo || {};
        const abs = (p) => (p ? apiBase() + p : null);
        return {
          uid: b.accountId || id,
          nickname: b.nickname,
          level: b.level,
          exp: b.exp,
          likes: b.liked,
          region: b.region,
          brPoints: b.rankingPoints,
          brRank: b.rank,
          csPoints: b.csRankingPoints,
          csRank: b.csRank,
          guild: clan.clanName || null,
          guildLevel: clan.clanLevel,
          guildMembers: clan.memberNum,
          gender: (social.gender || '').replace('Gender_', ''),
          language: (social.language || '').replace('Language_', ''),
          bio: social.signature || null,
          avatarUrl: abs(media.avatarUrl),
          bannerUrl: abs(media.bannerUrl)
        };
      }
    } catch (e) {
      if (e.message === 'Player not found.' || (e.message && e.message.startsWith('Lookup failed (HTTP'))) throw e;
      lastError = e.name === 'AbortError' ? new Error('Lookup timed out. Try again.') : e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 2000));
  }
  throw lastError || new Error('Lookup failed. Try again.');
}

module.exports = { lookupPlayer, apiBase };