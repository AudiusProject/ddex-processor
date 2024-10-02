/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['src/*.tsx'],
  theme: {
    extend: {},
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        day: {
          primary: '#cc0fe0',
          'primary-content': 'white',
          secondary: '#7e1bcc',
          'secondary-content': 'white',
          accent: '#37cdbe',
          neutral: '#f3f0f7',

          'base-100': 'white',
          'base-200': '#ccc',
          'base-300': '#f3f0f7',

          '--rounded-btn': '0.25rem',
        },
      },
      {
        dark: {
          primary: '#cc0fe0',
          'primary-content': 'white',
          secondary: '#7e1bcc',
          'secondary-content': 'white',
          'base-100': '#35364f',

          accent: 'oklch(74.51% 0.167 183.61)',
          neutral: '#2a323c',
          'neutral-content': '#A6ADBB',
          'base-200': '#191e24',
          'base-300': '#15191e',
          'base-content': '#A6ADBB',
        },
      },
    ],
  },
}
