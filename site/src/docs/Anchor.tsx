import { Link } from 'react-router';

/**
 * Internal links ("/docs/…") go through React Router, which adds the /llama-webui basename and navigates
 * client-side. Anchors and external links stay plain.
 */
export function Anchor({ href = '', children, ...props }: React.ComponentProps<'a'>) {
  if (href.startsWith('/')) {
    return (
      <Link to={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
