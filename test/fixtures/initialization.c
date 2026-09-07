/* Test the real pinned SQLite ABI with automatic initialization disabled. */
#define SQLITE_OMIT_AUTOINIT
#define SQLITE_ENABLE_COLUMN_METADATA
#ifdef _WIN32
#define SQLITE_API __declspec(dllexport)
#endif
#ifdef SQLITE_TEST_INITIALIZE_FAIL
#define sqlite3_initialize sqlite3_fixture_initialize
#endif
#include "sqlite3.c"
#ifdef SQLITE_TEST_INITIALIZE_FAIL
#undef sqlite3_initialize
SQLITE_API int sqlite3_initialize(void) { return SQLITE_NOMEM; }
#endif
