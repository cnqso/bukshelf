import Image from 'next/image';

export default function Offline() {
  const brandName = process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest';
  return (
    <div className='flex min-h-screen flex-col items-center justify-center bg-gray-100 text-center'>
      <div className='mb-4'>
        {brandName === 'Readest' ? (
          <Image src='/icon.png' alt='App Icon' width={100} height={100} className='rounded-lg' />
        ) : (
          <span className='grid h-[100px] w-[100px] place-items-center rounded-3xl bg-neutral-900 font-serif text-6xl font-semibold text-stone-50'>
            {brandName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <h1 className='text-2xl font-bold text-gray-800'>{brandName}</h1>

      <p className='mt-2 text-gray-600'>
        It seems you&apos;re offline. Please check your internet connection and try again.
      </p>
    </div>
  );
}
