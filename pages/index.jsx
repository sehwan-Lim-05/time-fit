import dynamic from 'next/dynamic';
import Head from 'next/head';

const TimeFitClient = dynamic(() => import('../src/main.jsx'), { ssr: false });

export default function HomePage() {
  return <>
    <Head><title>TimeFit | 근태 관리</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
    <TimeFitClient />
  </>;
}
