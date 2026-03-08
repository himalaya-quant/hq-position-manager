# 0.0.7

Introduced `syncCapital` feature:
Allows to forcefully sync the capital from outside.

# 0.0.6

Introduced commission model and spread calculation from pips (for supported markets).
Traditional markets will define the spread using the Spread.fromPips utility and pass:

- Spread in pips, as shown in the broker's fee table
- The pip size (for forex can use PipSize convenience mapping)

The commission model supports 3 types:

- perLot: Fixed commission per lot, per side. Common on Raw Spread accounts
  (e.g. ICMarkets cTrader: $3 per standard lot per side).

- percentageOfNotional: Percentage of the trade notional value, per side.
  Common on crypto spot and futures exchanges (Binance, Bybit, etc.).

- none: No commission. Use when the broker embeds all costs in the spread.
  (e.g. ICMarkets Standard Account, or crypto where spread covers cost).

# 0.0.5

Broker spread is now expected as a percentage of entry price.
Pass the number exactly as the broker advertises it — no conversion needed.

# 0.0.4

Fixed spread calculation. Now is percentage based instead of fixed value

# 0.0.3

Fixed max drawdown calculation

# 0.0.2

Removed module structure from readme contents

# 0.0.1

First commit:

- Implemented all the requirements defined in the analysis document. Although the library satisfies all the requirements, and is unit tested, before moving it to a stable version, we want to battle test it on the field.
