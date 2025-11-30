const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 6868,          // adjust if different
  user: 'postgres',
  password: 'giang',
  database: 'vietcensus',
});

module.exports = { pool };
