// Tailwind for the static pages, built once into tailwind.css (npm run build:css) instead of compiling
// in every browser through cdn.tailwindcss.com. Default theme, same as the CDN the pages used.
module.exports = {
  content: ['./*.html', './*.js'],
  theme: { extend: {} },
  plugins: [],
};
