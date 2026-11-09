import type { MDXComponents } from 'mdx/types';
import { Link } from 'react-router';

/**
 * Internal links ("/docs/…", "#anchor") go through React Router, which adds the /llama-webui basename and navigates
 * client-side. External links open normally.
 */
function Anchor({ href = '', children, ...props }: React.ComponentProps<'a'>) {
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

export const mdxComponents: MDXComponents = {
  a: Anchor,
};
