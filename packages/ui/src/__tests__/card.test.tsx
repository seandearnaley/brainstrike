import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../card';

describe('Card', () => {
  it('renders Card component', () => {
    render(<Card data-testid="card">Content</Card>);
    expect(screen.getByTestId('card')).toBeInTheDocument();
  });

  it('applies custom className to Card', () => {
    render(<Card className="custom-class">Content</Card>);
    expect(screen.getByText('Content').closest('div')).toHaveClass('custom-class');
  });

  it('renders CardHeader component', () => {
    render(<CardHeader data-testid="header">Header</CardHeader>);
    expect(screen.getByTestId('header')).toBeInTheDocument();
  });

  it('applies custom className to CardHeader', () => {
    render(<CardHeader className="header-class">Header</CardHeader>);
    expect(screen.getByText('Header')).toHaveClass('header-class');
  });

  it('renders CardFooter component', () => {
    render(<CardFooter data-testid="footer">Footer</CardFooter>);
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  it('applies custom className to CardFooter', () => {
    render(<CardFooter className="footer-class">Footer</CardFooter>);
    expect(screen.getByText('Footer')).toHaveClass('footer-class');
  });

  it('renders CardTitle component', () => {
    render(<CardTitle>Title</CardTitle>);
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('applies custom className to CardTitle', () => {
    render(<CardTitle className="title-class">Title</CardTitle>);
    expect(screen.getByText('Title')).toHaveClass('title-class');
  });

  it('renders CardDescription component', () => {
    render(<CardDescription>Description</CardDescription>);
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('applies custom className to CardDescription', () => {
    render(<CardDescription className="desc-class">Description</CardDescription>);
    expect(screen.getByText('Description')).toHaveClass('desc-class');
  });

  it('renders CardContent component', () => {
    render(<CardContent data-testid="content">Content</CardContent>);
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('applies custom className to CardContent', () => {
    render(<CardContent className="content-class">Content</CardContent>);
    expect(screen.getByText('Content')).toHaveClass('content-class');
  });

  it('renders full Card composition', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card description</CardDescription>
        </CardHeader>
        <CardContent>Main content</CardContent>
        <CardFooter>Footer content</CardFooter>
      </Card>
    );

    expect(screen.getByText('Card Title')).toBeInTheDocument();
    expect(screen.getByText('Card description')).toBeInTheDocument();
    expect(screen.getByText('Main content')).toBeInTheDocument();
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });
});
