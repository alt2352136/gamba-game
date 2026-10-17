// Session statistics and the top-five leaderboard are read/written separately from the
// round lifecycle so their SQL can be reviewed without navigating settlement code.
export function recordSettledRound(sql, round, item) {
  const wins = item.payout > item.stake ? 1 : 0;
  const losses = item.payout < item.stake ? 1 : 0;
  const pushes = item.payout === item.stake ? 1 : 0;
  const scoreMultiplier = item.result === "CASHED OUT" ? item.multiplier : 0;

  sql.exec(`INSERT INTO session_stats
    (id,rounds_played,wins,losses,pushes,total_staked,total_payout,net_result,best_multiplier,best_payout,updated_at)
    VALUES(1,1,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      rounds_played=session_stats.rounds_played+1,
      wins=session_stats.wins+excluded.wins,
      losses=session_stats.losses+excluded.losses,
      pushes=session_stats.pushes+excluded.pushes,
      total_staked=session_stats.total_staked+excluded.total_staked,
      total_payout=session_stats.total_payout+excluded.total_payout,
      net_result=session_stats.net_result+excluded.net_result,
      best_multiplier=MAX(session_stats.best_multiplier,excluded.best_multiplier),
      best_payout=MAX(session_stats.best_payout,excluded.best_payout),
      updated_at=excluded.updated_at`,
  wins, losses, pushes, item.stake, item.payout, item.net, scoreMultiplier, item.payout, item.at);

  // Low payouts do not need to trigger writes to the top-five leaderboard.
  if (item.result !== "CASHED OUT" || item.payout <= 0) return;

  const count = Number(sql.exec("SELECT COUNT(*) AS count FROM personal_bests").toArray()[0]?.count || 0);
  const lowest = sql.exec(`SELECT payout,multiplier FROM personal_bests
    ORDER BY payout ASC,multiplier ASC,created_at DESC LIMIT 1`).toArray()[0];
  const qualifies = count < 5 || !lowest || item.payout > Number(lowest.payout) ||
    (item.payout === Number(lowest.payout) && item.multiplier > Number(lowest.multiplier));
  if (!qualifies) return;

  sql.exec(`INSERT OR IGNORE INTO personal_bests
    (round_id,epoch,round_number,stake,payout,multiplier,net,result,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, round.id, round.epoch, item.round, item.stake, item.payout,
  item.multiplier, item.net, item.result, item.at);
  sql.exec(`DELETE FROM personal_bests WHERE round_id NOT IN (
    SELECT round_id FROM personal_bests ORDER BY payout DESC, multiplier DESC, created_at ASC LIMIT 5
  )`);
}

export function readProfileData(sql) {
  const row = sql.exec("SELECT * FROM session_stats WHERE id=1").toArray()[0] || {};
  const rounds = Number(row.rounds_played || 0);
  const stats = {
    roundsPlayed: rounds,
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    pushes: Number(row.pushes || 0),
    totalStaked: Number(row.total_staked || 0),
    totalPayout: Number(row.total_payout || 0),
    netResult: Number(row.net_result || 0),
    bestMultiplier: Number(row.best_multiplier || 0),
    bestPayout: Number(row.best_payout || 0),
    winRate: rounds ? (Number(row.wins || 0) / rounds) * 100 : 0
  };
  const leaderboard = sql.exec(`SELECT epoch,round_number,stake,payout,multiplier,net,result,created_at
    FROM personal_bests ORDER BY payout DESC,multiplier DESC,created_at ASC LIMIT 5`).toArray();
  return { stats, leaderboard };
}
