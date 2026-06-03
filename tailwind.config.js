/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./bot/index.html'],
  theme: {
    extend: {
      colors: {
        cream:     '#FFFDF9',
        beige:     '#F5E6D3',
        caramel:   '#E8B430',
        coffee:    '#6B4423',
        gold:      '#C9A227',
        warmWhite: '#FFFDF9',
      },
      fontFamily: {
        poppins:    ['Poppins', 'sans-serif'],
        montserrat: ['Montserrat', 'sans-serif'],
        playfair:   ['Playfair Display', 'serif'],
      },
    },
  },
  plugins: [],
};
