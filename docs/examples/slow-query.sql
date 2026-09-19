-- A slow query, for trying Optimize against.
--
-- Against the `perf_orders` (500,000 rows) and `perf_customers` (50,000 rows)
-- tables, this takes about 30 seconds on a laptop. Everything about it looks
-- reasonable; what makes it slow is invisible in the SQL and obvious in the
-- plan:
--
--   • three correlated subqueries, each of which scans all 500,000 orders
--     once per customer row — 1,120 customers × 500,000 rows, three times over
--   • `date(c.created_at) >= …` wraps the column in a function, so no index on
--     created_at could be used even if one existed
--
-- Press Explain to see it. Press Optimize to be told what to do about it:
-- `perf_orders (customer_id, status)`, measured by the planner at roughly
-- 900× cheaper. Building it takes the query from ~31 s to ~0.03 s.
--
-- The other candidate it offers, `perf_customers (tier)`, is measured at no
-- improvement and shown as such — which is the point of measuring.

WITH recent AS (
    SELECT c.id, c.name, c.country, c.tier
    FROM   perf_customers c
    WHERE  c.tier = 'enterprise'
      AND  date(c.created_at) >= date(now() - interval '60 days')
)
SELECT r.country,
       r.tier,
       r.name,
       (SELECT count(*)         FROM perf_orders o WHERE o.customer_id = r.id AND o.status = 'paid')     AS paid_orders,
       (SELECT sum(o.amount)    FROM perf_orders o WHERE o.customer_id = r.id AND o.status = 'paid')     AS paid_revenue,
       (SELECT max(o.placed_at) FROM perf_orders o WHERE o.customer_id = r.id AND o.status = 'refunded') AS last_refund,
       rank() OVER (PARTITION BY r.country
                    ORDER BY (SELECT coalesce(sum(o.amount), 0)
                              FROM perf_orders o
                              WHERE o.customer_id = r.id AND o.status = 'paid') DESC)                    AS rank_in_country
FROM   recent r
ORDER  BY paid_revenue DESC NULLS LAST
LIMIT  25;
