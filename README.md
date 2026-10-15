# gamba - crash game

A small browser game built with HTML, CSS and JavaScript.

## Rules

Start with 888 gold. Choose a stake, then hold the main button to begin; release to cash out. The multiplier rises by 0.8x per second and caps at x10. A crash loses the stake. A successful cash-out returns `floor(stake × multiplier)`; rounding down to whole gold can reduce the return slightly on small bets. The meter marker wobbles for atmosphere only; it does not affect the result.

Loans are available only at 0 gold. Each of the 444, 888 and 1,500 gold loans can be taken once per game. Each loan can be taken once per game. If you take another loan while debts are active, half the remaining rounds on the nearest existing deadline (rounded up) are added to every active deadline and to the new loan’s normal deadline. For example, an old loan with 4 rounds left and a new loan with a 4-round base deadline both get 6 rounds to repay. At the end of a round, affordable repayments are collected and every outstanding deadline advances. If the balance is 0 when a deadline expires, the game shows the zero-balance prompt first; any overdue debt must then be repaid immediately from a new loan, or the game ends due to default.

| Loan | Repayment | Deadline |
| ---: | ---: | ---: |
| 444 gold | 533 gold | 8 rounds |
| 888 gold | 1,110 gold | 6 rounds |
| 1,500 gold | 2,025 gold | 4 rounds |

## Probability model

Each round draws one uniformly distributed random value using the browser's Web Crypto API when available. The crash point is calculated with a cent-rounded formula and a 3% house edge. At fixed targets, the chance of reaching multiplier `m` is approximately `0.97 / m`: about 48.5% for x2, 19.4% for x5 and 9.7% for x10. Around 3.96% of rounds crash immediately at x1.00 because outcomes are floored to cents and values below x1.01 are clamped to x1.00. Before whole-gold payout rounding, the expected gross return at a fixed target is 97% of the stake; rounding down may lower it slightly.

A first-round x10 win is still possible: its probability is about 1 in 10.3. A higher house edge changes that probability only modestly because the target itself is high. The game does not adjust odds based on previous results or the player's balance. This is a local model inspired by common crash-game mechanics, not a certified or provably-fair casino implementation; results cannot be independently verified against a server seed.

References: [Bustabit mechanics](https://bustabit.com/articles/mechanics) · [UK Gambling Commission: random outcomes](https://www.gamblingcommission.gov.uk/manual/guidance-to-licensing-authorities/rts-7-generation-of-random-outcomes) · [MDN: Web Crypto `getRandomValues`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues) · [Mark Bollman, *Basic Gambling Mathematics*](https://www.routledge.com/Basic-Gambling-Mathematics-The-Numbers-Behind-The-Neon/Bollman/p/book/9781032414614)

## Input handling

The game tracks pointer release outside the button, pointer cancellation, focus loss, hidden tabs, and Space/Enter key release. The active animation frame is cancelled when a round settles. The wobble is CSS/marker-only; the multiplier, crash check and payout use the same underlying value.

## Files

- `index.html` — page structure and dialogs
- `styles.css` — layout and visual design
- `game.js` — game rules, controls, history and loans
- `honk-icon.png` — game icon from the supplied image
