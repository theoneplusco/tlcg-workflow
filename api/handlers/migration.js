// api/handlers/migration.js — Admin handlers for migration audit
module.exports = {
  updateEmployee: function(req) {
    const { fullName, email } = req.data;
    if (!fullName || !email) return { success: false, message: 'Missing fullName or email' };
    return { success: true, message: 'Run on server: psql -c "UPDATE employees SET email = \x27' + email.toLowerCase() + '\x27 WHERE full_name = \x27' + fullName + '\x27;"', sql: 'UPDATE employees SET email = \x27' + email.toLowerCase() + '\x27 WHERE full_name = \x27' + fullName + '\x27;' };
  },
  resetEmployees: function(req) {
    if (!confirm('Reset all employees to placeholder emails?')) return { cancelled: true };
    return { success: true, message: 'Run: psql tlcg_workflow -c \x27TRUNCATE employees RESTART IDENTITY CASCADE\x27; then node scripts/migrate-from-sheets.js' };
  }
};
