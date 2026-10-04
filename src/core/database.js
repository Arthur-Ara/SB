'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const DB_NAME_PATTERN = /^[A-Za-z0-9_$]+$/;

/**
 * Accès MySQL partagé par le cœur et les modules.
 *
 * Conventions :
 * - toutes les dates sont stockées en UTC (DATETIME) ;
 * - les IDs Discord (snowflakes) sont des BIGINT UNSIGNED, renvoyés en chaînes ;
 * - les agrégats (COUNT, SUM…) peuvent revenir en chaînes : les convertir avec Number().
 */
class Database {
  constructor(options, logger) {
    this.options = options;
    this.logger = logger;
    this.pool = null;
  }

  get connectionOptions() {
    const { host, port, user, password, database } = this.options;
    return {
      host,
      port,
      user,
      password,
      database,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
    };
  }

  async connect() {
    const { host, port, database } = this.options;
    if (!DB_NAME_PATTERN.test(database)) {
      throw new Error(`Nom de base de données invalide : "${database}"`);
    }
    await this.ensureDatabase();

    this.pool = mysql.createPool({
      ...this.connectionOptions,
      connectionLimit: 10,
      waitForConnections: true,
    });
    this.pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'", (err) => {
        if (err) this.logger.warn('Impossible de forcer le fuseau UTC sur la connexion', err.message);
      });
    });

    await this.pool.query('SELECT 1');
    this.logger.info(`Connecté à MySQL (${host}:${port}/${database})`);
  }

  /** Crée la base si elle n'existe pas (nécessite le droit CREATE, sinon simple avertissement). */
  async ensureDatabase() {
    const { database } = this.options;
    let connection;
    try {
      connection = await mysql.createConnection({ ...this.connectionOptions, database: undefined });
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } catch (err) {
      this.logger.warn(`Création automatique de la base "${database}" impossible : ${err.message}`);
    } finally {
      if (connection) await connection.end().catch(() => {});
    }
  }

  async query(sql, params = []) {
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  async one(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  async transaction(work) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Applique, dans l'ordre alphabétique, les fichiers .sql d'un dossier qui n'ont
   * pas encore été exécutés pour ce "scope" (core, module:stats, …).
   */
  async runMigrations(scope, dir) {
    await this.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        scope      VARCHAR(64)  NOT NULL,
        name       VARCHAR(191) NOT NULL,
        applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope, name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
    const appliedRows = await this.query('SELECT name FROM schema_migrations WHERE scope = ?', [scope]);
    const applied = new Set(appliedRows.map((row) => row.name));
    const pending = files.filter((file) => !applied.has(file));
    if (!pending.length) return;

    const connection = await mysql.createConnection({ ...this.connectionOptions, multipleStatements: true });
    try {
      await connection.query("SET time_zone = '+00:00'");
      for (const file of pending) {
        this.logger.info(`Migration ${scope} → ${file}`);
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        await connection.query(sql);
        await connection.query('INSERT INTO schema_migrations (scope, name) VALUES (?, ?)', [scope, file]);
      }
    } finally {
      await connection.end().catch(() => {});
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}

/** Découpe un tableau en paquets (insertion groupée). */
function chunk(items, size = 1000) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

module.exports = { Database, chunk };
