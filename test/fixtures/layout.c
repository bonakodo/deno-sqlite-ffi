#include "sqlite3.h"
#include <stddef.h>
#include <stdio.h>
#define CHECK(type, member, expected) if (offsetof(type, member) != expected) { fprintf(stderr, #type "." #member " has unexpected offset\n"); return 1; }
int main(void) {
  if (sizeof(void*) != 8 || sizeof(sqlite3_module) != 200 || sizeof(sqlite3_vtab) != 24 || sizeof(sqlite3_vtab_cursor) != 8 || sizeof(sqlite3_index_info) != 96) return 1;
  CHECK(sqlite3_module, xCreate, 8);
  CHECK(sqlite3_module, xConnect, 16);
  CHECK(sqlite3_module, xBestIndex, 24);
  CHECK(sqlite3_module, xDisconnect, 32);
  CHECK(sqlite3_module, xDestroy, 40);
  CHECK(sqlite3_module, xOpen, 48);
  CHECK(sqlite3_module, xClose, 56);
  CHECK(sqlite3_module, xFilter, 64);
  CHECK(sqlite3_module, xNext, 72);
  CHECK(sqlite3_module, xEof, 80);
  CHECK(sqlite3_module, xColumn, 88);
  CHECK(sqlite3_module, xRowid, 96);
  CHECK(sqlite3_vtab, zErrMsg, 16);
  CHECK(sqlite3_vtab_cursor, pVtab, 0);
  CHECK(sqlite3_index_info, nConstraint, 0);
  CHECK(sqlite3_index_info, aConstraint, 8);
  CHECK(sqlite3_index_info, aConstraintUsage, 32);
  CHECK(sqlite3_index_info, idxStr, 48);
  CHECK(sqlite3_index_info, needToFreeIdxStr, 56);
  CHECK(sqlite3_index_info, estimatedCost, 64);
  CHECK(sqlite3_index_info, estimatedRows, 72);
  if (sizeof(struct sqlite3_index_constraint) != 12 || sizeof(struct sqlite3_index_constraint_usage) != 8) return 1;
  CHECK(struct sqlite3_index_constraint, iColumn, 0);
  CHECK(struct sqlite3_index_constraint, op, 4);
  CHECK(struct sqlite3_index_constraint, usable, 5);
  CHECK(struct sqlite3_index_constraint_usage, argvIndex, 0);
  CHECK(struct sqlite3_index_constraint_usage, omit, 4);
  puts("SQLite 64-bit structure layouts verified");
  return 0;
}
