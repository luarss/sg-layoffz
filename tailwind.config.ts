import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sg: {
          red: '#EE2536',
          white: '#FFFFFF',
        },
      },
    },
  },
  plugins: [],
};

export default config;
