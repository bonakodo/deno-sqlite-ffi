/* A loadable extension can export symbols used inside another SQLite build.
 * Return a known error if the host resolves its internal sqlite3_exec here. */
#include "sqlite3.h"

int sqlite3_exec(sqlite3 *db, const char *sql,
                 int (*callback)(void *, int, char **, char **),
                 void *argument, char **error) {
  (void)db; (void)sql; (void)callback; (void)argument;
  if (error) *error = 0;
  return SQLITE_ERROR;
}

int sqlite3_extension_init(sqlite3 *db, char **error,
                           const sqlite3_api_routines *api) {
  (void)db; (void)error; (void)api;
  return SQLITE_OK;
}
