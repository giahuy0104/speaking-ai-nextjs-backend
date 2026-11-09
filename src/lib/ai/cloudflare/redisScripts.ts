// All keys are supplied explicitly and share the account's Redis Cluster hash tag.
// Limits in admissionStore.ts bound the number of rules and live leases per rule.
const TIME = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function extend(key, ttl)
  if redis.call('PTTL', key) < ttl then redis.call('PEXPIRE', key, math.ceil(ttl)) end
end
`;

const READ_RULES = `
local rules = cjson.decode(ARGV[1])
local states = {}
local retry = 0
local active = 0
for index, rule in ipairs(rules) do
  local stateKey = KEYS[2 * index + offset]
  local leasesKey = KEYS[2 * index + offset + 1]
  redis.call('ZREMRANGEBYSCORE', leasesKey, '-inf', now)
  local count = redis.call('ZCARD', leasesKey)
  active = math.max(active, count)
  local cool = tonumber(redis.call('HGET', stateKey, 'cooldown') or '0')
  retry = math.max(retry, cool - now)
  local pending = redis.call('HGET', stateKey, 'pending') == '1'
  local probe = redis.call('HGET', stateKey, 'probe') or ''
  local probeUntil = probe ~= '' and tonumber(redis.call('ZSCORE', leasesKey, probe) or '0') or 0
  if pending and probeUntil > now then retry = math.max(retry, probeUntil - now) end
  if count >= rule.maxConcurrent then
    local first = redis.call('ZRANGE', leasesKey, 0, 0, 'WITHSCORES')
    retry = math.max(retry, tonumber(first[2]) - now)
  end
  local tokens = 0
  if rule.rpm then
    local last = tonumber(redis.call('HGET', stateKey, 'updated') or now)
    tokens = tonumber(redis.call('HGET', stateKey, 'tokens') or rule.burst)
    tokens = math.min(rule.burst, tokens + math.max(0, now - last) * rule.rpm / 60000)
    if tokens < 1 then retry = math.max(retry, math.ceil((1 - tokens) * 60000 / rule.rpm)) end
  end
  states[index] = { tokens = tokens, pending = pending, cool = cool }
end
`;

export const ACQUIRE_SCRIPT = TIME + `
local existing = redis.call('GET', KEYS[2])
if existing then
  local lease = cjson.decode(existing)
  if lease.signature ~= ARGV[4] then return redis.error_reply('INVALID_LEASE') end
  return {1, lease.expiresAt, lease.probe and 1 or 0}
end
local accountCool = tonumber(redis.call('HGET', KEYS[1], 'cooldown') or '0')
local accountPending = redis.call('HGET', KEYS[1], 'pending') == '1'
local accountProbeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
local accountRetry = math.max(0, accountCool - now, accountPending and accountProbeUntil - now or 0)
if accountRetry > 0 then return {0, math.ceil(accountRetry)} end
local offset = 1
` + READ_RULES + `
if retry > 0 then return {0, math.ceil(retry)} end
local ttl = tonumber(ARGV[3])
local expires = now + ttl
local isProbe = accountPending
if accountPending then
  redis.call('HSET', KEYS[1], 'probe', ARGV[2], 'probeUntil', expires)
  extend(KEYS[1], math.max(600000, ttl + 1000))
end
for index, rule in ipairs(rules) do
  local stateKey = KEYS[2 * index + offset]
  local leasesKey = KEYS[2 * index + offset + 1]
  local state = states[index]
  if rule.rpm then redis.call('HSET', stateKey, 'tokens', tostring(math.max(0, state.tokens - 1)), 'updated', now) end
  if state.pending then
    isProbe = true
    redis.call('HSET', stateKey, 'probe', ARGV[2])
  else
    redis.call('HSET', stateKey, 'pending', '0')
  end
  redis.call('ZADD', leasesKey, expires, ARGV[2])
  extend(leasesKey, ttl + 1000)
  local retention = math.max(600000, ttl + 1000, state.cool - now + 600000)
  if rule.rpm then retention = math.max(retention, math.ceil(rule.burst * 60000 / rule.rpm) + 1000) end
  extend(stateKey, retention)
end
redis.call('SET', KEYS[2], cjson.encode({expiresAt = expires, signature = ARGV[4], probe = isProbe}), 'PX', ttl)
return {1, expires, isProbe and 1 or 0}
`;

export const SNAPSHOT_SCRIPT = TIME + `
local accountCool = tonumber(redis.call('HGET', KEYS[1], 'cooldown') or '0')
local accountPending = redis.call('HGET', KEYS[1], 'pending') == '1'
local accountProbeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
local accountRetry = math.max(0, accountCool - now, accountPending and accountProbeUntil - now or 0)
local offset = 0
` + READ_RULES + `
return {active, math.max(0, math.ceil(retry), math.ceil(accountRetry))}
`;

export const COMPLETE_SCRIPT = TIME + `
local existing = redis.call('GET', KEYS[2])
if not existing then return 0 end
local lease = cjson.decode(existing)
if lease.expiresAt ~= tonumber(ARGV[2]) or lease.signature ~= ARGV[3] or lease.expiresAt <= now then return 0 end
local outcome = cjson.decode(ARGV[4])
local scopes = cjson.decode(ARGV[5])
if outcome.disable then
  local accountCool = math.max(tonumber(redis.call('HGET', KEYS[1], 'cooldown') or '0'), now + 86400000)
  redis.call('HSET', KEYS[1], 'cooldown', accountCool, 'pending', '1', 'probe', '', 'probeUntil', '0')
  extend(KEYS[1], accountCool - now + 600000)
elseif redis.call('HGET', KEYS[1], 'probe') == ARGV[1] then
  if outcome.cooldownMs and outcome.cooldownMs > 0 then
    redis.call('HSET', KEYS[1], 'cooldown', now + outcome.cooldownMs, 'pending', '1', 'probe', '', 'probeUntil', '0')
    extend(KEYS[1], outcome.cooldownMs + 600000)
  else
    redis.call('HSET', KEYS[1], 'cooldown', '0', 'pending', '0', 'probe', '', 'probeUntil', '0')
  end
end
for index = 1, (#KEYS - 2) / 2 do
  local stateKey = KEYS[2 * index + 1]
  local leasesKey = KEYS[2 * index + 2]
  if outcome.cooldownMs and outcome.cooldownMs > 0 and scopes[index] then
    local cool = math.max(tonumber(redis.call('HGET', stateKey, 'cooldown') or '0'), now + outcome.cooldownMs)
    redis.call('HSET', stateKey, 'cooldown', cool, 'pending', '1', 'probe', '')
    extend(stateKey, cool - now + 600000)
  elseif redis.call('HGET', stateKey, 'probe') == ARGV[1] then
    redis.call('HSET', stateKey, 'pending', '0', 'probe', '')
  end
  redis.call('ZREM', leasesKey, ARGV[1])
end
redis.call('DEL', KEYS[2])
return 1
`;
