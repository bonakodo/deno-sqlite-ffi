/** SQLite fixed-argument FFI declarations. */
export const symbols = {
  sqlite3_initialize: { parameters: [], result: 'i32', optional: true },
  sqlite3_libversion_number: { parameters: [], result: 'i32', optional: true },
  sqlite3_libversion: { parameters: [], result: 'pointer', optional: true },
  sqlite3_sourceid: { parameters: [], result: 'pointer', optional: true },
  sqlite3_threadsafe: { parameters: [], result: 'i32', optional: true },
  sqlite3_compileoption_get: {
    parameters: ['i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_open_v2: {
    parameters: ['buffer', 'buffer', 'i32', 'pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_close_v2: { parameters: ['pointer'], result: 'i32', optional: true },
  sqlite3_errmsg: {
    parameters: ['pointer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_extended_errcode: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_extended_result_codes: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_busy_timeout: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_get_autocommit: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_changes: { parameters: ['pointer'], result: 'i32', optional: true },
  sqlite3_total_changes: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_last_insert_rowid: {
    parameters: ['pointer'],
    result: 'i64',
    optional: true,
  },
  sqlite3_prepare_v2: {
    parameters: ['pointer', 'buffer', 'i32', 'buffer', 'buffer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_step: { parameters: ['pointer'], result: 'i32', optional: true },
  sqlite3_reset: { parameters: ['pointer'], result: 'i32', optional: true },
  sqlite3_finalize: { parameters: ['pointer'], result: 'i32', optional: true },
  sqlite3_clear_bindings: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_stmt_readonly: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_stmt_status: {
    parameters: ['pointer', 'i32', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_sql: { parameters: ['pointer'], result: 'pointer', optional: true },
  sqlite3_expanded_sql: {
    parameters: ['pointer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_bind_parameter_count: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_bind_parameter_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_bind_null: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_bind_int64: {
    parameters: ['pointer', 'i32', 'i64'],
    result: 'i32',
    optional: true,
  },
  sqlite3_bind_double: {
    parameters: ['pointer', 'i32', 'f64'],
    result: 'i32',
    optional: true,
  },
  sqlite3_bind_text: {
    parameters: ['pointer', 'i32', 'buffer', 'i32', 'pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_bind_blob: {
    parameters: ['pointer', 'i32', 'buffer', 'i32', 'pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_column_count: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_column_type: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_column_int64: {
    parameters: ['pointer', 'i32'],
    result: 'i64',
    optional: true,
  },
  sqlite3_column_double: {
    parameters: ['pointer', 'i32'],
    result: 'f64',
    optional: true,
  },
  sqlite3_column_text: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_blob: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_bytes: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_column_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_decltype: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_origin_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_table_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_column_database_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_malloc64: { parameters: ['u64'], result: 'pointer', optional: true },
  sqlite3_free: { parameters: ['pointer'], result: 'void', optional: true },
  sqlite3_create_function_v2: {
    parameters: [
      'pointer',
      'buffer',
      'i32',
      'i32',
      'pointer',
      'function',
      'function',
      'function',
      'function',
    ],
    result: 'i32',
    optional: true,
  },
  sqlite3_create_window_function: {
    parameters: [
      'pointer',
      'buffer',
      'i32',
      'i32',
      'pointer',
      'function',
      'function',
      'function',
      'function',
      'function',
    ],
    result: 'i32',
    optional: true,
  },
  sqlite3_aggregate_context: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_value_type: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_value_int64: {
    parameters: ['pointer'],
    result: 'i64',
    optional: true,
  },
  sqlite3_value_double: {
    parameters: ['pointer'],
    result: 'f64',
    optional: true,
  },
  sqlite3_value_text: {
    parameters: ['pointer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_value_blob: {
    parameters: ['pointer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_value_bytes: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_result_null: {
    parameters: ['pointer'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_int64: {
    parameters: ['pointer', 'i64'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_double: {
    parameters: ['pointer', 'f64'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_text: {
    parameters: ['pointer', 'buffer', 'i32', 'pointer'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_blob: {
    parameters: ['pointer', 'buffer', 'i32', 'pointer'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_error: {
    parameters: ['pointer', 'buffer', 'i32'],
    result: 'void',
    optional: true,
  },
  sqlite3_result_error_nomem: {
    parameters: ['pointer'],
    result: 'void',
    optional: true,
  },
  sqlite3_db_filename: {
    parameters: ['pointer', 'buffer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_backup_init: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_backup_step: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_backup_finish: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_backup_remaining: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_backup_pagecount: {
    parameters: ['pointer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_serialize: {
    parameters: ['pointer', 'buffer', 'buffer', 'u32'],
    result: 'pointer',
    optional: true,
  },
  sqlite3_deserialize: {
    parameters: ['pointer', 'buffer', 'pointer', 'i64', 'i64', 'u32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_enable_load_extension: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
  sqlite3_load_extension: {
    parameters: ['pointer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
    optional: true,
  },
  sqlite3_create_module_v2: {
    parameters: [
      'pointer',
      'buffer',
      'pointer',
      'pointer',
      'function',
    ],
    result: 'i32',
    optional: true,
  },
  sqlite3_declare_vtab: {
    parameters: ['pointer', 'buffer'],
    result: 'i32',
    optional: true,
  },
  // DIRECTONLY takes no variadic arguments: the two fixed arguments suffice.
  sqlite3_vtab_config: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
    optional: true,
  },
} as const;

export const groups = {
  metadata: [
    'sqlite3_column_origin_name',
    'sqlite3_column_table_name',
    'sqlite3_column_database_name',
  ],
  functions: [
    'sqlite3_create_function_v2',
    'sqlite3_aggregate_context',
    'sqlite3_value_type',
    'sqlite3_value_int64',
    'sqlite3_value_double',
    'sqlite3_value_text',
    'sqlite3_value_blob',
    'sqlite3_value_bytes',
    'sqlite3_result_null',
    'sqlite3_result_int64',
    'sqlite3_result_double',
    'sqlite3_result_text',
    'sqlite3_result_blob',
    'sqlite3_result_error',
    'sqlite3_result_error_nomem',
  ],
  windows: ['sqlite3_create_window_function'],
  backup: [
    'sqlite3_db_filename',
    'sqlite3_backup_init',
    'sqlite3_backup_step',
    'sqlite3_backup_finish',
    'sqlite3_backup_remaining',
    'sqlite3_backup_pagecount',
  ],
  serialize: ['sqlite3_serialize'],
  deserialize: ['sqlite3_deserialize'],
  extensions: ['sqlite3_enable_load_extension', 'sqlite3_load_extension'],
  tables: [
    'sqlite3_create_module_v2',
    'sqlite3_declare_vtab',
    'sqlite3_vtab_config',
  ],
} as const;
/** Optional SQLite native feature groups. */
export type Capability =
  | 'metadata'
  | 'functions'
  | 'windows'
  | 'backup'
  | 'serialize'
  | 'deserialize'
  | 'extensions'
  | 'tables';
export type Symbols = {
  [K in keyof typeof symbols]: NonNullable<
    Deno.StaticForeignLibraryInterface<typeof symbols>[K]
  >;
};
