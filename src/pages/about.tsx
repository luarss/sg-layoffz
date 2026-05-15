import Layout from '@/components/Layout';

export default function About() {
  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">About</h1>

        <div className="prose prose-gray max-w-none space-y-6">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">What is sg-layoffz?</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              sg-layoffz is a tracker for layoff and retrenchment events at companies with a
              presence in Singapore. It aims to provide a clear, sortable, and filterable view of
              publicly reported job cuts — similar to what layoffs.fyi does globally, but focused
              on Singapore.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Methodology</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              Data is collected from public news sources including Straits Times, Business Times,
              Channel NewsAsia, Vulcan Post, Tech in Asia, and international outlets for larger
              companies. Entries go through a manual review process before being published.
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-sm text-gray-600">
              <li><strong>Confirmed</strong>: Reported by at least one credible news source</li>
              <li><strong>Rumored</strong>: Reported but not yet independently verified</li>
              <li><strong>Reference</strong>: Official MOM statistics for context</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Limitations</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              This tracker covers only publicly reported layoffs. Small-scale layoffs, unreported
              retrenchments, and headcount reductions through attrition or non-renewal of contracts
              are generally not captured. The data should be treated as indicative, not exhaustive.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Official Data</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              For official retrenchment statistics, refer to the{' '}
              <a
                href="https://stats.mom.gov.sg/Pages/Retrenchment-Summary-Table.aspx"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-900 underline"
              >
                MOM Retrenchment Summary Table
              </a>
              , which publishes quarterly aggregate numbers broken down by sector and employment
              type.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Disclaimer</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              This site is for informational purposes only. Data may contain errors or omissions.
              Not financial, legal, or career advice. If you spot an error, please open an issue
              on the project repository.
            </p>
          </section>
        </div>
      </div>
    </Layout>
  );
}
