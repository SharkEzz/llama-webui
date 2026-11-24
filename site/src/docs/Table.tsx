import { HScroll } from './HScroll';

export function Table(props: React.ComponentProps<'table'>) {
  return (
    <HScroll className="my-6 rounded-xl ring-1 ring-border">
      <table className="w-full text-sm [&_td:first-child_code]:whitespace-nowrap" {...props} />
    </HScroll>
  );
}
